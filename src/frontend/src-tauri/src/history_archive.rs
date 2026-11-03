use crate::vault::{self, VaultState};
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use chrono::{DateTime, Local};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Cursor, Read, Write}, path::Path};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};
use base64::Engine;
use zeroize::Zeroizing;

const MAX_BYTES: usize = 64 * 1024 * 1024;
const ENTRY_NAME: &str = "assetops-history.bin";
const HEADER: &[u8] = b"AssetOpsHistory\x01";
const PASSWORD_HEADER: &[u8] = b"AssetOpsHistory\x02";
// 只用于读取旧版归档，禁止再用此常量生成新归档。
const KEY_DOMAIN: &[u8] = b"AssetOps/history-archive/v1/2026-10/local-portable-archive";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryArchive {
    format: String,
    version: u32,
    exported_at: String,
    period: String,
    start: String,
    end: String,
    records: Vec<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    insecure_legacy: bool,
}
fn is_false(value: &bool) -> bool { !value }

// v2 归档固定此派生协议，不随数据仓库后续的密钥参数调整而变化。
fn archive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = argon2::Params::new(65_536, 3, 1, Some(32)).map_err(|error| error.to_string())?;
    let mut key = Zeroizing::new([0_u8; 32]);
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params).hash_password_into(password.as_bytes(), salt, key.as_mut()).map_err(|error| error.to_string())?;
    Ok(key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExport { path: String, archive: HistoryArchive }

fn timestamp(value: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(value).map_err(|_| "归档时间格式无效".to_owned())
}

fn validate(archive: &HistoryArchive) -> Result<(), String> {
    if archive.format != "assetops-history" || archive.version != 1 {
        return Err("此归档格式或版本不受支持".into());
    }
    if !["week", "month"].contains(&archive.period.as_str()) || timestamp(&archive.start)? >= timestamp(&archive.end)? {
        return Err("归档日期范围无效".into());
    }
    timestamp(&archive.exported_at)?;
    let start = timestamp(&archive.start)?;
    let end = timestamp(&archive.end)?;
    if archive.records.is_empty() { return Err("归档中没有变更记录".into()); }
    let mut ids = HashSet::new();
    for record in &archive.records {
        let id = record.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("变更记录标识无效")?;
        if !ids.insert(id) { return Err("归档中存在重复的变更记录".into()); }
        let at = timestamp(record.get("at").and_then(Value::as_str).ok_or("变更记录时间无效")?)?;
        if at < start || at >= end { return Err("变更记录超出归档日期范围".into()); }
        if record.get("assetName").and_then(Value::as_str).is_none() || !["新增", "编辑", "删除", "恢复", "回滚"].contains(&record.get("action").and_then(Value::as_str).unwrap_or("")) {
            return Err("变更记录内容无效".into());
        }
        for key in ["assetId", "systemId", "objectType", "objectId", "objectName", "source", "batchId", "operator", "note"] {
            if record.get(key).is_some_and(|value| !value.is_string()) { return Err(format!("记录 {id} 的 {key} 格式无效")); }
        }
        if let Some(items) = record.get("items") {
            let items = items.as_array().ok_or("变更明细格式无效")?;
            if items.iter().any(|item| item.get("fieldKey").and_then(Value::as_str).is_none()) { return Err("变更明细字段无效".into()); }
            for item in items {
                if item.get("fieldLabel").is_some_and(|value| !value.is_string()) { return Err(format!("记录 {id} 的 items.fieldLabel 格式无效")); }
                if item.get("fieldKey").and_then(Value::as_str) == Some("accounts") {
                    for side in ["before", "after"] {
                        if let Some(value) = item.get(side).filter(|value| !value.is_null()) {
                            let valid = value.as_array().is_some_and(|accounts| accounts.iter().all(|account| account.is_object() && ["id", "username", "password"].iter().all(|key| account.get(key).is_none_or(Value::is_string))));
                            if !valid { return Err(format!("记录 {id} 的 items.accounts.{side} 格式无效")); }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn encode(archive: &HistoryArchive, password: &str) -> Result<Vec<u8>, String> {
    validate(archive)?;
    if password.is_empty() { return Err("请输入当前主密码以加密归档".into()); }
    let json = Zeroizing::new(serde_json::to_vec(archive).map_err(|error| error.to_string())?);
    if json.len() > MAX_BYTES { return Err("单个归档不能超过 64 MB，请缩小日期范围".into()); }
    let mut compressor = DeflateEncoder::new(Vec::new(), Compression::default());
    compressor.write_all(&json).map_err(|error| error.to_string())?;
    let compressed = Zeroizing::new(compressor.finish().map_err(|error| error.to_string())?);
    let mut salt = [0_u8; 16]; getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    let key = archive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| error.to_string())?;
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let nonce_value = Nonce::try_from(nonce.as_slice()).map_err(|error| error.to_string())?;
    let aad = [PASSWORD_HEADER, &salt].concat();
    let encrypted = cipher.encrypt(&nonce_value, Payload { msg: &compressed, aad: &aad }).map_err(|_| "归档加密失败")?;
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(ENTRY_NAME, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).map_err(|error| error.to_string())?;
    zip.write_all(&aad).and_then(|_| zip.write_all(&nonce)).and_then(|_| zip.write_all(&encrypted)).map_err(|error| error.to_string())?;
    let bytes = zip.finish().map_err(|error| error.to_string())?.into_inner();
    if bytes.len() > MAX_BYTES { return Err("单个归档不能超过 64 MB，请缩小日期范围".into()); }
    Ok(bytes)
}

fn decode(bytes: &[u8], password: &str) -> Result<HistoryArchive, String> {
    if bytes.len() > MAX_BYTES { return Err("归档文件不能超过 64 MB".into()); }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "这不是有效的工作台历史归档 ZIP")?;
    if zip.len() != 1 { return Err("归档文件内容无效".into()); }
    let mut file = zip.by_index(0).map_err(|_| "归档内容读取失败")?;
    if file.name() != ENTRY_NAME || file.size() > MAX_BYTES as u64 || file.compression() != CompressionMethod::Stored { return Err("归档文件内容无效".into()); }
    let mut payload = Vec::new();
    file.by_ref().take(MAX_BYTES as u64 + 1).read_to_end(&mut payload).map_err(|_| "归档文件已损坏")?;
    let protected = payload.starts_with(PASSWORD_HEADER);
    let aad_len = HEADER.len() + if protected { 16 } else { 0 }; let prefix = aad_len + 12;
    if payload.len() > MAX_BYTES || payload.len() < prefix + 16 || (!protected && !payload.starts_with(HEADER)) { return Err("归档加密格式无效".into()); }
    let key = if protected { archive_key(password, &payload[PASSWORD_HEADER.len()..aad_len])? } else { Zeroizing::new(Sha256::digest(KEY_DOMAIN).into()) };
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| error.to_string())?;
    let nonce = Nonce::try_from(&payload[aad_len..prefix]).map_err(|_| "归档随机值无效")?;
    let compressed = Zeroizing::new(cipher.decrypt(&nonce, Payload { msg: &payload[prefix..], aad: &payload[..aad_len] }).map_err(|_| "归档校验失败，请检查归档主密码或文件是否损坏")?);
    let mut json = Zeroizing::new(Vec::new());
    DeflateDecoder::new(compressed.as_slice()).take(MAX_BYTES as u64 + 1).read_to_end(&mut json).map_err(|_| "归档解压失败")?;
    if json.len() > MAX_BYTES { return Err("归档解压后超过 64 MB".into()); }
    let mut archive: HistoryArchive = serde_json::from_slice(&json).map_err(|_| "归档记录格式无效")?;
    validate(&archive)?;
    archive.insecure_legacy = !protected;
    Ok(archive)
}

fn write_verified(path: &Path, archive: &HistoryArchive, password: &str) -> Result<(), String> {
    let bytes = encode(archive, password)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|error| format!("归档文件创建失败：{error}"))?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| format!("归档文件写入失败，数据库记录已保留：{error}"))?;
    drop(file);
    let saved = fs::read(path).map_err(|_| "归档文件回读失败，数据库记录已保留")?;
    if decode(&saved, password)? != *archive { return Err("归档文件回读校验不一致，数据库记录已保留".into()); }
    Ok(())
}

fn create_archive_directory(application_directory: &Path) -> Result<std::path::PathBuf, String> {
    let directory = application_directory.join("history-archives");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建历史归档目录：{error}"))?;
    Ok(directory)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn export_history_archive(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, ids: Vec<String>, period: String, start: String, end: String, password: String) -> Result<ArchiveExport, String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权归档变更记录".into()); }
    let _operation = state.begin_operation()?;
    let password = Zeroizing::new(password); vault::verify_password(&state, &password)?;
    let data = vault::read_unlocked(&state)?;
    let wanted: HashSet<_> = ids.iter().map(String::as_str).collect();
    if wanted.is_empty() || wanted.len() != ids.len() { return Err("请先选择要归档的记录".into()); }
    let records: Vec<_> = data.get("history").and_then(Value::as_array).ok_or("变更记录格式无效")?.iter().filter(|record| wanted.contains(record.get("id").and_then(Value::as_str).unwrap_or(""))).cloned().collect();
    if records.len() != ids.len() { return Err("变更记录已更新，请重新归档".into()); }
    let archive = HistoryArchive { format: "assetops-history".into(), version: 1, exported_at: Local::now().to_rfc3339(), period, start, end, records, insecure_legacy: false };
    let executable = std::env::current_exe().map_err(|error| format!("无法定位应用目录：{error}"))?;
    let application_directory = executable.parent().ok_or("无法定位应用目录")?;
    let directory = create_archive_directory(application_directory)?;
    let path = directory.join(format!("历史变更-{}-{}.zip", timestamp(&archive.start)?.format("%Y%m%d"), Local::now().format("%Y%m%d-%H%M%S-%f")));
    write_verified(&path, &archive, &password)?;
    Ok(ArchiveExport { path: path.to_string_lossy().into_owned(), archive })
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn read_history_archive(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, request: tauri::ipc::Request<'_>) -> Result<HistoryArchive, String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权导入变更记录".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    let encoded = request.headers().get("x-archive-password").map(|value| value.to_str().map_err(|_| "归档密码传输无效")).transpose()?.unwrap_or("");
    if encoded.len() > 8192 { return Err("归档密码过长".into()); }
    let password = Zeroizing::new(base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "归档密码传输无效")?);
    decode_request(request.body(), std::str::from_utf8(&password).map_err(|_| "归档密码传输无效")?)
}

fn decode_request(body: &tauri::ipc::InvokeBody, password: &str) -> Result<HistoryArchive, String> {
    let fallback;
    let bytes = match body {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(Value::Array(values)) => {
            if values.len() > MAX_BYTES { return Err("归档文件不能超过 64 MB".into()); }
            fallback = values.iter().map(|value| value.as_u64().and_then(|value| u8::try_from(value).ok()).ok_or("归档文件传输字节无效"))
                .collect::<Result<Vec<_>, _>>()?;
            fallback.as_slice()
        }
        _ => return Err("归档文件传输格式无效，请重新选择文件".into()),
    };
    decode(bytes, password)
}

#[tauri::command(async)]
pub fn compact_history_database(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权整理数据库".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    compact(&vault::open(&state)?)
}

fn compact(connection: &rusqlite::Connection) -> Result<(), String> {
    connection.execute_batch("VACUUM;").map_err(|error| format!("整理数据库失败：{error}"))?;
    crate::storage::checkpoint_database(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> HistoryArchive {
        HistoryArchive { format: "assetops-history".into(), version: 1, exported_at: "2026-10-13T10:00:00+08:00".into(), period: "month".into(), start: "2026-10-01T00:00:00+08:00".into(), end: "2026-11-01T00:00:00+08:00".into(), insecure_legacy: false, records: vec![json!({"id":"history-test", "at":"2026-10-13T09:00:00+08:00", "assetName":"测试服务器", "action":"编辑", "before":{"password":"private-secret"}, "after":{"notes":"重复内容".repeat(2000)}, "items":[{"fieldKey":"notes", "before":"旧值", "after":"新值"}]})] }
    }
    #[test]
    fn malformed_display_fields_and_accounts_are_rejected_before_encoding() {
        for key in ["assetId", "systemId", "objectType", "objectId", "objectName", "source", "batchId", "operator", "note"] {
            let mut archive = fixture(); archive.records[0][key] = json!({"unexpected": "object"});
            let error = encode(&archive, "archive-test").unwrap_err(); assert!(error.contains("history-test") && error.contains(key));
        }
        for item in [json!({"fieldKey":"ip", "fieldLabel":{}}), json!({"fieldKey":"accounts", "before":[null]}), json!({"fieldKey":"accounts", "after":[{"username":42}]})] {
            let mut archive = fixture(); archive.records[0]["items"] = json!([item]); assert!(encode(&archive, "archive-test").unwrap_err().contains("history-test"));
        }
        let mut archive = fixture(); archive.records[0]["items"] = json!([{"fieldKey":"accounts", "before":null, "after":[]}, {"fieldKey":"custom", "before":{"nested":[null, 1]}}]);
        assert_eq!(decode(&encode(&archive, "archive-test").unwrap(), "archive-test").unwrap(), archive);
    }
    #[test]
    fn portable_archive_compresses_encrypts_and_authenticates() {
        let archive = fixture(); let bytes = encode(&archive, "archive-test").unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(bytes.len() < serde_json::to_vec(&archive).unwrap().len() / 2);
        assert!(!bytes.windows(14).any(|part| part == b"private-secret"));
        assert_ne!(bytes, encode(&archive, "archive-test").unwrap(), "每次归档使用新的随机值");
        assert_eq!(decode(&bytes, "archive-test").unwrap(), archive);
        let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap(); let mut payload = Vec::new(); zip.by_index(0).unwrap().read_to_end(&mut payload).unwrap();
        *payload.last_mut().unwrap() ^= 1;
        let mut altered = ZipWriter::new(Cursor::new(Vec::new())); altered.start_file(ENTRY_NAME, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap(); altered.write_all(&payload).unwrap();
        assert!(decode(&altered.finish().unwrap().into_inner(), "archive-test").unwrap_err().contains("校验失败"));
    }
    #[test]
    fn password_archive_rejects_wrong_password_and_the_old_application_key() {
        let bytes = encode(&fixture(), "archive-password").unwrap();
        assert!(decode(&bytes, "wrong-password").is_err());
        assert!(decode(&bytes, "").is_err());
        let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap(); let mut payload = Vec::new(); zip.by_index(0).unwrap().read_to_end(&mut payload).unwrap();
        assert!(payload.starts_with(PASSWORD_HEADER));
        let aad_len = PASSWORD_HEADER.len() + 16; let prefix = aad_len + 12;
        let cipher = Aes256Gcm::new_from_slice(&Sha256::digest(KEY_DOMAIN)).unwrap();
        assert!(cipher.decrypt(&Nonce::try_from(&payload[aad_len..prefix]).unwrap(), Payload { msg: &payload[prefix..], aad: &payload[..aad_len] }).is_err());
    }

    #[test]
    fn old_archives_remain_readable_but_are_marked_insecure() {
        let archive = fixture(); let mut compressor = DeflateEncoder::new(Vec::new(), Compression::default()); compressor.write_all(&serde_json::to_vec(&archive).unwrap()).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&Sha256::digest(KEY_DOMAIN)).unwrap(); let nonce = [3_u8; 12];
        let encrypted = cipher.encrypt(&Nonce::try_from(nonce.as_slice()).unwrap(), Payload { msg: &compressor.finish().unwrap(), aad: HEADER }).unwrap();
        let mut zip = ZipWriter::new(Cursor::new(Vec::new())); zip.start_file(ENTRY_NAME, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
        zip.write_all(HEADER).unwrap(); zip.write_all(&nonce).unwrap(); zip.write_all(&encrypted).unwrap();
        let old = decode(&zip.finish().unwrap().into_inner(), "").unwrap();
        assert!(old.insecure_legacy); assert_eq!(old.records, archive.records);
    }
    #[test]
    fn raw_request_preserves_archive_bytes_and_rejects_invalid_payloads() {
        let archive = fixture();
        let bytes = encode(&archive, "archive-test").unwrap();
        assert_eq!(decode_request(&tauri::ipc::InvokeBody::Raw(bytes.clone()), "archive-test").unwrap(), decode(&bytes, "archive-test").unwrap());
        assert_eq!(decode_request(&tauri::ipc::InvokeBody::Json(serde_json::to_value(&bytes).unwrap()), "archive-test").unwrap(), archive);
        for invalid in [json!([-1]), json!([1.5]), json!([1.0]), json!([256]), json!([null]), json!([true]), json!(["1"])] {
            assert!(decode_request(&tauri::ipc::InvokeBody::Json(invalid), "archive-test").unwrap_err().contains("传输字节无效"));
        }
        assert!(decode_request(&tauri::ipc::InvokeBody::Json(json!({"content": "UEs="})), "archive-test").unwrap_err().contains("传输格式无效"));
        assert!(decode_request(&tauri::ipc::InvokeBody::Raw(Vec::new()), "archive-test").is_err());
        let mut boundary = vec![0; MAX_BYTES];
        assert!(decode(&boundary, "archive-test").unwrap_err().contains("不是有效"));
        boundary.push(0);
        assert!(decode_request(&tauri::ipc::InvokeBody::Raw(boundary), "archive-test").unwrap_err().contains("64 MB"));
    }
    #[test]
    fn invalid_versions_duplicates_ranges_and_zip_entries_are_rejected() {
        let mut archive = fixture(); archive.version = 2; assert!(encode(&archive, "archive-test").is_err()); archive.version = 1;
        archive.records.push(archive.records[0].clone()); assert!(encode(&archive, "archive-test").is_err()); archive.records.pop();
        archive.end = archive.start.clone(); assert!(encode(&archive, "archive-test").is_err());
        assert!(decode(b"not a zip", "archive-test").is_err());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new())); zip.start_file("../history.json", SimpleFileOptions::default()).unwrap(); zip.write_all(b"{}").unwrap();
        assert!(decode(&zip.finish().unwrap().into_inner(), "archive-test").is_err());
    }
    #[test]
    fn file_is_read_back_before_success_and_existing_file_is_not_overwritten() {
        let path = std::env::temp_dir().join(format!("assetops-history-test-{}-{}.zip", std::process::id(), Local::now().timestamp_nanos_opt().unwrap()));
        let archive = fixture(); write_verified(&path, &archive, "archive-test").unwrap();
        assert_eq!(decode(&fs::read(&path).unwrap(), "archive-test").unwrap(), archive);
        assert!(write_verified(&path, &archive, "archive-test").is_err());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn archive_uses_a_dedicated_application_directory() {
        let application_directory = std::env::temp_dir().join(format!("assetops-archive-directory-{}-{}", std::process::id(), Local::now().timestamp_nanos_opt().unwrap()));
        let directory = create_archive_directory(&application_directory).unwrap();
        assert_eq!(directory, application_directory.join("history-archives"));
        assert!(directory.is_dir());
        assert_eq!(create_archive_directory(&application_directory).unwrap(), directory);
        write_verified(&directory.join("history.zip"), &fixture(), "archive-test").unwrap();
        assert_eq!(decode(&fs::read(directory.join("history.zip")).unwrap(), "archive-test").unwrap(), fixture());
        fs::remove_file(directory.join("history.zip")).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(application_directory).unwrap();
    }
    #[test]
    fn compact_reclaims_database_pages_without_changing_remaining_payload() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE vault (id INTEGER PRIMARY KEY, ciphertext BLOB); INSERT INTO vault VALUES (1, zeroblob(2097152));").unwrap();
        connection.execute("UPDATE vault SET ciphertext = ?1 WHERE id = 1", [b"remaining-payload".as_slice()]).unwrap();
        let before: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        compact(&connection).unwrap();
        let after: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        assert!(after < before);
        assert_eq!(connection.query_row("SELECT ciphertext FROM vault", [], |row| row.get::<_, Vec<u8>>(0)).unwrap(), b"remaining-payload");
    }
}
