use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::{params, Connection};
use serde_json::json;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Mutex, MutexGuard},
};
use zeroize::Zeroizing;
#[cfg(test)]
thread_local! { static REPLACEMENT_FAILURE: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }

const ENVELOPE_HEADER: &[u8] = b"AssetOpsVault\x02";

pub struct VaultState {
    db_path: Mutex<PathBuf>,
    key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    command_dispatch: Mutex<()>,
    operation: Mutex<()>,
    restarting: AtomicBool,
    data_version: Mutex<Option<u64>>,
    format_upgrade_pending: AtomicBool,
}

impl VaultState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path: Mutex::new(db_path),
            key: Mutex::new(None),
            command_dispatch: Mutex::new(()),
            operation: Mutex::new(()),
            restarting: AtomicBool::new(false),
            data_version: Mutex::new(None),
            format_upgrade_pending: AtomicBool::new(false),
        }
    }

    pub(crate) fn begin_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let guard = self.operation.try_lock().map_err(|_| "正在保存或维护数据，请稍后再操作".to_owned())?;
        if self.restarting.load(Ordering::SeqCst) { return Err("应用正在重启，请稍后再操作".to_owned()); }
        Ok(guard)
    }

    pub(crate) fn wait_for_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation.lock().map_err(|error| error.to_string())
    }

    // 工作线程串行执行外部数据命令，内部操作继续检查重入。
    pub(crate) fn wait_for_command(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.command_dispatch.lock().map_err(|error| error.to_string())
    }

    pub(crate) fn prepare_restart(&self) -> Result<(), String> {
        let _operation = self.begin_operation()?;
        crate::storage::checkpoint_database(&open(self)?)?;
        self.restarting.store(true, Ordering::SeqCst);
        *self.key.lock().map_err(|error| error.to_string())? = None;
        Ok(())
    }

    pub(crate) fn db_path(&self) -> Result<PathBuf, String> {
        self.db_path
            .lock()
            .map(|path| path.clone())
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    pub(crate) fn set_db_path(&self, path: PathBuf) -> Result<(), String> {
        *self.db_path.lock().map_err(|error| error.to_string())? = path;
        Ok(())
    }

    pub(crate) fn is_unlocked(&self) -> Result<bool, String> {
        Ok(self
            .key
            .lock()
            .map_err(|error| error.to_string())?
            .is_some())
    }
}

pub fn initialize(db_path: &PathBuf) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS vault (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            salt BLOB NOT NULL,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        PRAGMA user_version = 2;",
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(65_536, 3, 1, Some(32)).map_err(|error| error.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn encrypt(data: &Value, key: &[u8; 32]) -> Result<([u8; 12], Vec<u8>), String> {
    validate_payload(data)?;
    crate::export_path::validate_setting(data)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let plaintext = Zeroizing::new(serde_json::to_vec(data).map_err(|error| error.to_string())?);
    let nonce_value = Nonce::try_from(nonce.as_slice()).map_err(|error| error.to_string())?;
    let ciphertext = cipher
        .encrypt(&nonce_value, Payload { msg: &plaintext, aad: ENVELOPE_HEADER })
        .map_err(|error| error.to_string())?;
    Ok((nonce, [ENVELOPE_HEADER, ciphertext.as_slice()].concat()))
}

fn decrypt(ciphertext: &[u8], nonce: &[u8], key: &[u8; 32]) -> Result<Value, String> {
    let nonce = Nonce::try_from(nonce).map_err(|_| "本地数据库格式错误".to_owned())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let (ciphertext, aad) = if let Some(ciphertext) = ciphertext.strip_prefix(ENVELOPE_HEADER) { (ciphertext, ENVELOPE_HEADER) } else { (ciphertext, b"".as_slice()) };
    let plaintext = Zeroizing::new(cipher
        .decrypt(&nonce, Payload { msg: ciphertext, aad })
        .map_err(|_| "主密码错误或本地数据已损坏".to_owned())?);
    let data = serde_json::from_slice(&plaintext).map_err(|_| "本地数据格式错误".to_owned())?;
    validate_payload(&data)?;
    Ok(data)
}

fn validate_payload(data: &Value) -> Result<(), String> {
    if !data.is_object() { return Err("本地数据格式错误，原数据已保留".to_owned()); }
    if let Some(version) = data.get("version") {
        let version = version.as_u64().ok_or("数据仓库版本格式错误，原数据已保留")?;
        if version > 4 { return Err("数据仓库版本高于当前应用支持的版本，请使用新版应用打开".to_owned()); }
    }
    for pointer in ["/units", "/assets", "/fieldDefs", "/fieldTemplates", "/history", "/opsSystems", "/reports/entries", "/reports/reports", "/reports/calendar/tasks", "/reports/calendar/exclusions"] {
        let Some(value) = data.pointer(pointer) else { continue; };
        let values = value.as_array().ok_or_else(|| format!("数据列表格式错误：{pointer}"))?;
        let mut ids = std::collections::HashSet::new();
        for value in values {
            if !value.is_object() { return Err(format!("数据列表记录格式错误：{pointer}")); }
            if let Some(id) = value.get("id") {
                let id = id.as_str().filter(|id| !id.is_empty()).ok_or_else(|| format!("数据标识无效：{pointer}"))?;
                if !ids.insert(id) { return Err(format!("数据标识重复：{pointer}")); }
            }
        }
    }
    Ok(())
}

pub(crate) fn open(state: &VaultState) -> Result<Connection, String> {
    Connection::open(state.db_path()?).map_err(|error| error.to_string())
}

fn read_envelope(connection: &Connection) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    connection
        .query_row(
            "SELECT salt, nonce, ciphertext FROM vault WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "找不到本地数据或数据库读取失败".to_owned())
}

pub(crate) fn verify_password(state: &VaultState, password: &str) -> Result<(), String> {
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    let (salt, nonce, ciphertext) = read_envelope(&open(state)?)?;
    let key = derive_key(password, &salt)?;
    decrypt(&ciphertext, &nonce, &key).map(|_| ()).map_err(|_| "当前主密码不正确".into())
}

fn prepare_backup_reencryptions(
    state: &VaultState,
    old_password: Option<&str>,
    new_salt: &[u8; 16],
    new_key: &[u8; 32],
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let current_key = state
        .key
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .cloned()
        .ok_or("数据仓库尚未解锁")?;
    let mut prepared = Vec::new();
    let result = (|| {
        for backup in crate::backup::list_backup_files(state)? {
            let source = PathBuf::from(backup.path);
            if backup.integrity != "ok" { continue; }
            let source_connection = Connection::open(&source).map_err(|error| error.to_string())?;
            let (salt, nonce, ciphertext) = read_envelope(&source_connection)?;
            let data = match decrypt(&ciphertext, &nonce, &current_key) {
                Ok(data) => data,
                Err(_) => {
                    let Some(password) = old_password else {
                        continue;
                    };
                    let old_key = derive_key(password, &salt)?;
                    let Ok(data) = decrypt(&ciphertext, &nonce, &old_key) else {
                        continue;
                    };
                    data
                }
            };
            drop(source_connection);

            let temporary = source.with_extension("password-change.tmp");
            fs::copy(&source, &temporary).map_err(|error| error.to_string())?;
            let prepare_result = (|| {
                let (new_nonce, new_ciphertext) = encrypt(&data, new_key)?;
                let connection = Connection::open(&temporary).map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "UPDATE vault SET salt = ?1, nonce = ?2, ciphertext = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                        params![new_salt.as_slice(), new_nonce.as_slice(), new_ciphertext],
                    )
                    .map_err(|error| error.to_string())?;
                crate::storage::checkpoint_database(&connection)?;
                Ok::<(), String>(())
            })();
            if let Err(error) = prepare_result {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            prepared.push((temporary, source));
        }
        Ok(())
    })();
    if let Err(error) = result {
        for (temporary, _) in &prepared {
            let _ = fs::remove_file(temporary);
        }
        return Err(error);
    }
    Ok(prepared)
}

pub(crate) fn read_unlocked(state: &VaultState) -> Result<Value, String> {
    let key = state.key.lock().map_err(|error| error.to_string())?;
    let key = key.as_ref().ok_or("数据仓库尚未解锁")?;
    let connection = open(state)?;
    let (_, nonce, ciphertext) = read_envelope(&connection)?;
    decrypt(&ciphertext, &nonce, key)
}

pub(crate) fn read_backup_data(
    state: &VaultState,
    path: &Path,
    password: Option<&str>,
) -> Result<Value, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let (salt, nonce, ciphertext) = read_envelope(&connection)?;
    let key = state
        .key
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .cloned()
        .ok_or("数据仓库尚未解锁")?;
    if let Ok(data) = decrypt(&ciphertext, &nonce, &key) {
        return Ok(data);
    }
    let password = password
        .filter(|value| !value.is_empty())
        .ok_or("备份需要原主密码")?;
    let key = derive_key(password, &salt)?;
    decrypt(&ciphertext, &nonce, &key).map_err(|_| "备份主密码不正确或备份数据已损坏".to_owned())
}

#[tauri::command(async)]
pub fn vault_exists(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<bool, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let connection = open(&state)?;
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault WHERE id = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn vault_create(window: tauri::WebviewWindow,
    password: String,
    data: Value,
    state: tauri::State<'_, VaultState>,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    if password.is_empty() {
        return Err("主密码不能为空".to_owned());
    }
    let connection = open(&state)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault WHERE id = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists {
        return Err("本地数据仓库已存在".to_owned());
    }

    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    let key = derive_key(&password, &salt)?;
    let (nonce, ciphertext) = encrypt(&data, &key)?;
    connection
        .execute(
            "INSERT INTO vault (id, salt, nonce, ciphertext) VALUES (1, ?1, ?2, ?3)",
            params![salt.as_slice(), nonce.as_slice(), ciphertext],
        )
        .map_err(|error| error.to_string())?;
    *state.key.lock().map_err(|error| error.to_string())? = Some(key);
    *state.data_version.lock().map_err(|error| error.to_string())? = data.get("version").and_then(Value::as_u64);
    Ok(())
}

#[tauri::command(async)]
pub fn vault_unlock(window: tauri::WebviewWindow,
    password: String,
    state: tauri::State<'_, VaultState>,
) -> Result<Value, String> {
    let password = Zeroizing::new(password);
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    unlock_data(&state, &password)
}

fn unlock_data(state: &VaultState, password: &str) -> Result<Value, String> {
    let connection = open(&state)?;
    let (salt, nonce, ciphertext) = read_envelope(&connection)?;
    let key = derive_key(&password, &salt)?;
    let data = decrypt(&ciphertext, &nonce, &key)?;
    state.format_upgrade_pending.store(!ciphertext.starts_with(ENVELOPE_HEADER), Ordering::SeqCst);
    *state.data_version.lock().map_err(|error| error.to_string())? = data.get("version").and_then(Value::as_u64);
    *state.key.lock().map_err(|error| error.to_string())? = Some(key);
    Ok(data)
}

#[tauri::command(async)]
pub fn vault_save(window: tauri::WebviewWindow, data: Value, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    save_data(&data, &state)
}

pub(crate) fn save_data(data: &Value, state: &VaultState) -> Result<(), String> {
    let _operation = state.begin_operation()?;
    save_unlocked(data, state)
}

pub(crate) fn save_unlocked(data: &Value, state: &VaultState) -> Result<(), String> {
    let version = data.get("version").and_then(Value::as_u64);
    if state.format_upgrade_pending.load(Ordering::SeqCst) || *state.data_version.lock().map_err(|error| error.to_string())? != version {
        validate_payload(data)?; crate::export_path::validate_setting(data)?;
        crate::backup::create_backup_file(state, "pre-schema")?;
    }
    let key = state.key.lock().map_err(|error| error.to_string())?;
    let key = key.as_ref().ok_or("数据仓库尚未解锁")?;
    let connection = open(&state)?;
    let (nonce, ciphertext) = encrypt(data, key)?;
    let updated = connection.execute(
        "UPDATE vault SET nonce = ?1, ciphertext = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
        params![nonce.as_slice(), ciphertext],
    ).map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("找不到本地数据".to_owned());
    }
    state.format_upgrade_pending.store(false, Ordering::SeqCst);
    *state.data_version.lock().map_err(|error| error.to_string())? = version;
    Ok(())
}

#[tauri::command(async)]
pub fn vault_lock(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.command_dispatch.lock().unwrap_or_else(|error| error.into_inner());
    lock_vault(&state)
}

fn lock_vault(state: &VaultState) -> Result<(), String> {
    let _operation = state.operation.lock().unwrap_or_else(|error| error.into_inner());
    state.key.lock().unwrap_or_else(|error| error.into_inner()).take();
    Ok(())
}

#[tauri::command(async)]
pub fn vault_change_password(window: tauri::WebviewWindow,
    old_password: String,
    new_password: String,
    state: tauri::State<'_, VaultState>,
) -> Result<(), String> {
    let old_password = Zeroizing::new(old_password);
    let new_password = Zeroizing::new(new_password);
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    change_password(&state, &old_password, &new_password)
}

fn change_password(
    state: &VaultState,
    old_password: &str,
    new_password: &str,
) -> Result<(), String> {
    let _operation = state.begin_operation()?;
    if new_password.is_empty() {
        return Err("新主密码不能为空".to_owned());
    }
    let connection = open(state)?;
    let (salt, nonce, ciphertext) = read_envelope(&connection)?;
    let old_key = derive_key(old_password, &salt)?;
    let data = decrypt(&ciphertext, &nonce, &old_key)?;
    replace_vault(
        state,
        &data,
        new_password,
        Some(old_password),
        "password-change",
    )
}

fn replace_vault(
    state: &VaultState,
    data: &Value,
    new_password: &str,
    old_password: Option<&str>,
    backup_kind: &str,
) -> Result<(), String> {
    let action = if backup_kind == "reinitialize" { "重新初始化" } else { "主密码切换" };
    let old_key = state.key.lock().unwrap_or_else(|error| error.into_inner()).clone().ok_or("数据仓库尚未解锁")?;
    let old_version = *state.data_version.lock().map_err(|error| error.to_string())?;
    let old_format = state.format_upgrade_pending.load(Ordering::SeqCst);
    let mut connection = open(&state)?;
    let (salt, nonce, ciphertext) = read_envelope(&connection)?;
    crate::backup::create_backup_file(state, backup_kind)?;

    let mut new_salt = [0_u8; 16];
    getrandom::fill(&mut new_salt).map_err(|error| error.to_string())?;
    let new_key = derive_key(new_password, &new_salt)?;
    let (new_nonce, new_ciphertext) = encrypt(data, &new_key)?;
    let prepared_backups = if backup_kind == "reinitialize" { Vec::new() } else { prepare_backup_reencryptions(state, old_password, &new_salt, &new_key)? };
    let update_result = (|| {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let updated = transaction.execute(
            "UPDATE vault SET salt = ?1, nonce = ?2, ciphertext = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
            params![new_salt.as_slice(), new_nonce.as_slice(), new_ciphertext],
        ).map_err(|error| error.to_string())?;
        if updated != 1 { return Err("找不到本地数据".to_owned()); }
        transaction.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = update_result {
        for (temporary, _) in &prepared_backups { let _ = fs::remove_file(temporary); }
        return Err(error);
    }
    *state.key.lock().unwrap_or_else(|error| error.into_inner()) = Some(new_key.clone());
    *state.data_version.lock().unwrap_or_else(|error| error.into_inner()) = data.get("version").and_then(Value::as_u64);
    state.format_upgrade_pending.store(false, Ordering::SeqCst);
    let mut replaced_backups = Vec::new();
    let replacement_result = (|| {
        for (temporary, destination) in &prepared_backups {
            #[cfg(test)]
            if REPLACEMENT_FAILURE.with(|remaining| match remaining.get() { Some(0) => { remaining.set(None); true }, Some(value) => { remaining.set(Some(value - 1)); false }, None => false }) { return Err("模拟备份替换失败".into()); }
            let rollback = destination.with_extension(format!("password-change-{}.rollback", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
            fs::copy(destination, &rollback).map_err(|error| error.to_string())?;
            fs::OpenOptions::new().write(true).open(&rollback).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
            replaced_backups.push((destination.clone(), rollback));
            crate::storage::atomic_replace(temporary, destination)?;
            let backup_connection =
                Connection::open(destination).map_err(|error| error.to_string())?;
            let (_, backup_nonce, backup_ciphertext) = read_envelope(&backup_connection)?;
            decrypt(&backup_ciphertext, &backup_nonce, &new_key)?;
        }
        if backup_kind == "reinitialize" {
            connection.execute_batch("VACUUM;").map_err(|error| format!("回收数据库空间失败：{error}"))?;
            crate::storage::checkpoint_database(&connection)?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = replacement_result {
        let mut rollback_errors = Vec::new();
        for (destination, rollback) in replaced_backups.iter().rev() {
            if let Err(reason) = crate::storage::atomic_replace(rollback, destination) { rollback_errors.push(format!("备份 {}：{reason}", destination.display())); }
        }
        for (temporary, _) in &prepared_backups {
            let _ = fs::remove_file(temporary);
        }
        if let Err(reason) = connection
            .execute(
                "UPDATE vault SET salt = ?1, nonce = ?2, ciphertext = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                params![salt, nonce, ciphertext],
            )
        { rollback_errors.push(format!("数据库：{reason}")); }
        if !rollback_errors.is_empty() {
            state.key.lock().unwrap_or_else(|error| error.into_inner()).take();
            return Err(format!("{action}失败且自动回滚未完成，数据仓库已锁定。原始备份和恢复文件已保留：{}；原始错误：{error}", rollback_errors.join("；")));
        }
        *state.key.lock().unwrap_or_else(|error| error.into_inner()) = Some(old_key);
        *state.data_version.lock().unwrap_or_else(|error| error.into_inner()) = old_version;
        state.format_upgrade_pending.store(old_format, Ordering::SeqCst);
        return Err(format!("{action}失败，已恢复原数据：{error}"));
    }
    for (temporary, _) in &prepared_backups {
        let _ = fs::remove_file(temporary);
    }
    for (_, rollback) in &replaced_backups {
        let _ = fs::remove_file(rollback);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn vault_reinitialize(window: tauri::WebviewWindow,
    password: String,
    state: tauri::State<'_, VaultState>,
) -> Result<Value, String> {
    let password = Zeroizing::new(password);
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    reinitialize(&state, &password)
}

fn reinitialize(state: &VaultState, password: &str) -> Result<Value, String> {
    let _operation = state.begin_operation()?;
    if password.is_empty() {
        return Err("主密码不能为空".to_owned());
    }

    let mut data = json!({ "units": [], "assets": [], "history": [] });
    let mut connection = open(&state)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault WHERE id = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists {
        let current = read_unlocked(state)?;
        if let Some(directory) = current.pointer("/settings/backupDirectory") {
            data["settings"] = json!({ "backupDirectory": directory });
        }
        replace_vault(state, &data, password, None, "reinitialize")?;
        return Ok(data);
    }

    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    let key = derive_key(&password, &salt)?;
    let (nonce, ciphertext) = encrypt(&data, &key)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO vault (id, salt, nonce, ciphertext, updated_at)
             VALUES (1, ?1, ?2, ?3, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               salt = excluded.salt,
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               updated_at = CURRENT_TIMESTAMP",
            params![salt.as_slice(), nonce.as_slice(), ciphertext],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    *state.key.lock().map_err(|error| error.to_string())? = Some(key);
    *state.data_version.lock().map_err(|error| error.to_string())? = data.get("version").and_then(Value::as_u64);
    state.format_upgrade_pending.store(false, Ordering::SeqCst);
    Ok(data)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) struct TestVault {
        pub(crate) root: PathBuf,
        pub(crate) state: VaultState,
    }

    impl TestVault {
        pub(crate) fn new(password: &str, data: Value) -> Self {
            let root = std::env::temp_dir().join(format!(
                "assetops-vault-test-{}-{}",
                std::process::id(),
                chrono::Local::now().timestamp_nanos_opt().unwrap()
            ));
            fs::create_dir(&root).unwrap();
            let state = VaultState::new(root.join("assets.db"));
            initialize(&state.db_path().unwrap()).unwrap();
            let test = Self { root, state };
            test.install(password, &data);
            test
        }

        fn install(&self, password: &str, data: &Value) {
            let salt = [5_u8; 16];
            let key = derive_key(password, &salt).unwrap();
            let (nonce, ciphertext) = encrypt(data, &key).unwrap();
            open(&self.state).unwrap().execute(
                "INSERT OR REPLACE INTO vault (id, salt, nonce, ciphertext) VALUES (1, ?1, ?2, ?3)",
                params![salt.as_slice(), nonce.as_slice(), ciphertext],
            ).unwrap();
            *self.state.key.lock().unwrap() = Some(key);
            *self.state.data_version.lock().unwrap() = data.get("version").and_then(Value::as_u64);
        }

        fn unlocks_with(&self, password: &str) -> bool {
            let (salt, nonce, ciphertext) = read_envelope(&open(&self.state).unwrap()).unwrap();
            let key = derive_key(password, &salt).unwrap();
            decrypt(&ciphertext, &nonce, &key).is_ok()
        }
    }

    impl Drop for TestVault {
        fn drop(&mut self) {
            if self.root.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("assetops-vault-test-")
            {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }

    #[test]
    fn restart_rejects_busy_writes_and_closes_future_operations() {
        let test = TestVault::new("test", json!({"assets": [{"host": "saved"}]}));
        let guard = test.state.begin_operation().unwrap();
        assert!(test.state.prepare_restart().unwrap_err().contains("正在保存"));
        assert!(test.state.is_unlocked().unwrap());
        drop(guard);
        test.state.prepare_restart().unwrap();
        assert!(!test.state.is_unlocked().unwrap());
        assert!(test.state.begin_operation().unwrap_err().contains("重启"));
        assert!(test.unlocks_with("test"));
    }

    #[test]
    fn short_passwords_work_and_empty_passwords_do_not_change_data() {
        let test = TestVault::new("old", json!({"assets": [{"host": "original"}]}));
        assert!(change_password(&test.state, "wrong", "new").is_err());
        assert!(change_password(&test.state, "old", "").is_err());
        assert!(reinitialize(&test.state, "").is_err());
        assert!(test.unlocks_with("old"));
        change_password(&test.state, "old", "new").unwrap();
        assert!(test.unlocks_with("new"));
        assert!(!test.unlocks_with("old"));
        reinitialize(&test.state, "x").unwrap();
        assert!(test.unlocks_with("x"));
    }

    #[test]
    fn report_and_system_domains_survive_backup_restore_and_password_change() {
        let original = json!({ "version": 4, "assets": [], "reports": { "entries": [{ "id": "work", "text": "巡检记录" }], "reports": [{ "id": "report", "markdown": "周报正文" }], "calendar": { "exclusions": [{ "date": "2026-10-08", "part": "am" }] } }, "opsSystems": [{ "systemId": "system", "markdown": "系统资料", "topology": { "nodes": [{ "id": "node", "assetId": "asset" }], "edges": [] }, "revisions": [{ "id": "revision", "markdown": "旧资料" }] }] });
        let test = TestVault::new("old", original.clone());
        let backup = crate::backup::create_backup_file(&test.state, "manual").unwrap();
        save_unlocked(&json!({ "assets": [], "reports": {}, "opsSystems": [] }), &test.state).unwrap();
        change_password(&test.state, "old", "new").unwrap();
        assert_eq!(crate::backup::restore_backup(&test.state, &backup.file_name, None).unwrap(), original);
        assert_eq!(read_unlocked(&test.state).unwrap()["reports"], original["reports"]);
        assert_eq!(read_unlocked(&test.state).unwrap()["opsSystems"], original["opsSystems"]);
        assert!(test.unlocks_with("new"));
    }

    #[test]
    fn reinitialize_reclaims_database_pages_and_preserves_backup() {
        let original = json!({"assets": [{"id": "asset", "host": "server", "custom": {"notes": "x".repeat(768 * 1024)}}], "units": []});
        let test = TestVault::new("old", original.clone());
        let database = test.state.db_path().unwrap();
        let before = fs::metadata(&database).unwrap().len();
        assert!(before > 700 * 1024);
        let _idle_connection = open(&test.state).unwrap();
        reinitialize(&test.state, "new").unwrap();
        assert!(read_unlocked(&test.state).unwrap()["assets"].as_array().unwrap().is_empty());
        let after = fs::metadata(&database).unwrap().len();
        let connection = open(&test.state).unwrap();
        let free: i64 = connection.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        let page_size: u32 = connection.query_row("PRAGMA page_size", [], |row| row.get(0)).unwrap();
        assert!(after <= u64::from(page_size) * 4, "初始化后应回收空闲页：{before} -> {after} 字节，空闲页 {free}");
        assert_eq!(free, 0);
        assert_eq!(fs::metadata(database.with_extension("db-wal")).map(|value| value.len()).unwrap_or(0), 0);
        assert!(test.unlocks_with("new"));
        assert!(!test.unlocks_with("old"));
        let backups = crate::backup::list_backup_files(&test.state).unwrap();
        assert!(!backups.is_empty());
        assert_eq!(read_backup_data(&test.state, Path::new(&backups[0].path), Some("old")).unwrap(), original);
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            fs::write(PathBuf::from(directory).join("reinitialize-space.json"), serde_json::to_vec(&json!({"before": before, "after": after, "freelist": free, "backupRestorable": true})).unwrap()).unwrap();
        }
    }

    #[test]
    fn reinitialize_keeps_backups_restorable_for_same_and_different_passwords() {
        for password in ["old", "new"] {
            let original = json!({"assets": [{"host": "original"}], "units": []});
            let test = TestVault::new("old", original.clone());
            let backup = crate::backup::create_backup_file(&test.state, "manual").unwrap();
            let saved_backup = fs::read(&backup.path).unwrap();
            let reset = reinitialize(&test.state, password).unwrap();
            assert!(reset["assets"].as_array().unwrap().is_empty());
            assert_eq!(fs::read(&backup.path).unwrap(), saved_backup, "重新初始化不能接管或改写旧备份");
            let restored =
                crate::backup::restore_backup(&test.state, &backup.file_name, Some("old")).unwrap();
            assert_eq!(restored, original);
            assert!(test.unlocks_with(password));
            change_password(&test.state, password, "next").unwrap();
            assert!(test.unlocks_with("next"));
        }
    }

    #[test]
    fn legacy_password_backup_does_not_block_password_change_and_can_be_restored() {
        let original = json!({"assets": [{"host": "legacy"}]});
        let test = TestVault::new("old", original.clone());
        let backup = crate::backup::create_backup_file(&test.state, "manual").unwrap();
        let original_bytes = fs::read(&backup.path).unwrap();
        // 模拟旧版本初始化：当前库换密码，备份仍保留旧加密。
        test.install("current", &json!({"assets": []}));
        change_password(&test.state, "current", "next").unwrap();
        assert_eq!(fs::read(&backup.path).unwrap(), original_bytes);
        assert_eq!(
            crate::backup::restore_backup(&test.state, &backup.file_name, None).unwrap_err(),
            "备份需要原主密码"
        );
        assert!(
            crate::backup::restore_backup(&test.state, &backup.file_name, Some("wrong")).is_err()
        );
        assert_eq!(read_unlocked(&test.state).unwrap()["assets"], json!([]));
        let restored =
            crate::backup::restore_backup(&test.state, &backup.file_name, Some("old")).unwrap();
        assert_eq!(restored, original);
        assert!(test.unlocks_with("next"));
        assert!(!test.unlocks_with("old"));
    }

    #[test]
    fn reinitialize_preserves_custom_backup_directory() {
        let test = TestVault::new("old", json!({"assets": []}));
        let directory = test.root.join("custom-backups");
        save_unlocked(
            &json!({"assets": [], "settings": {"backupDirectory": directory}}),
            &test.state,
        )
        .unwrap();
        reinitialize(&test.state, "new").unwrap();
        assert_eq!(
            crate::backup::backup_directory(&test.state).unwrap(),
            directory
        );
        assert!(!fs::read_dir(directory)
            .unwrap()
            .collect::<Vec<_>>()
            .is_empty());
    }

    #[test]
    fn encrypted_payload_round_trips_and_rejects_wrong_key() {
        let value = json!({ "host": "server-01", "password": "secret" });
        let key = [7_u8; 32];
        let (nonce, ciphertext) = encrypt(&value, &key).expect("encrypt");

        assert_eq!(decrypt(&ciphertext, &nonce, &key).expect("decrypt"), value);
        assert!(decrypt(&ciphertext, &nonce, &[8_u8; 32]).is_err());
    }

    #[test]
    fn invalid_and_future_payloads_never_replace_saved_data() {
        let original = json!({"version": 4, "assets": [{"id": "kept", "host": "original"}]});
        let test = TestVault::new("test", original.clone());
        for invalid in [Value::Null, json!([]), json!({"version": 5}), json!({"version": "4"}), json!({"version": -1}), json!({"version": null}), json!({"assets": {}}), json!({"assets": [null]}), json!({"assets": [{"id": "same"}, {"id": "same"}]})] {
            assert!(save_data(&invalid, &test.state).is_err());
            assert_eq!(read_unlocked(&test.state).unwrap(), original);
        }
        save_data(&json!({"version": 4, "assets": []}), &test.state).unwrap();
        assert_eq!(read_unlocked(&test.state).unwrap()["assets"], json!([]));
    }

    #[test]
    fn failed_save_and_password_change_keep_original_data_and_allow_retry() {
        let original = json!({"version": 4, "assets": [], "reports": {"entries": [{"id": "saved", "text": "保留数据"}]}});
        let test = TestVault::new("old", original.clone());
        let connection = open(&test.state).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_vault_update BEFORE UPDATE ON vault WHEN EXISTS(SELECT 1 FROM pragma_database_list WHERE file LIKE '%assets.db') BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
        assert!(save_data(&json!({"assets": []}), &test.state).is_err());
        assert_eq!(read_unlocked(&test.state).unwrap(), original);
        assert!(change_password(&test.state, "old", "new").is_err());
        assert!(test.unlocks_with("old"));
        assert!(!test.unlocks_with("new"));
        let backups = crate::backup::backup_directory(&test.state).unwrap();
        assert!(fs::read_dir(&backups).unwrap().all(|entry| !entry.unwrap().path().extension().is_some_and(|value| value == "tmp")));
        connection.execute_batch("DROP TRIGGER reject_vault_update;").unwrap();
        change_password(&test.state, "old", "new").unwrap();
        assert_eq!(read_unlocked(&test.state).unwrap(), original);
        assert!(test.unlocks_with("new"));
    }

    #[test]
    fn busy_wal_checkpoint_never_creates_a_stale_backup() {
        let test = TestVault::new("test", json!({"assets": [{"host": "original"}]}));
        let reader = open(&test.state).unwrap();
        reader.execute_batch("BEGIN; SELECT * FROM vault;").unwrap();
        let latest = json!({"assets": [{"host": "latest"}]});
        save_data(&latest, &test.state).unwrap();
        assert!(crate::backup::create_backup_file(&test.state, "busy").unwrap_err().contains("占用"));
        assert_eq!(read_unlocked(&test.state).unwrap(), latest);
        assert!(crate::backup::list_backup_files(&test.state).unwrap().is_empty());
        reader.execute_batch("ROLLBACK;").unwrap();
        let backup = crate::backup::create_backup_file(&test.state, "retry").unwrap();
        assert_eq!(read_backup_data(&test.state, Path::new(&backup.path), None).unwrap(), latest);
    }

    #[test]
    fn backup_paths_exclude_live_database_and_its_hard_links() {
        let original = json!({"assets": [{"host": "protected"}]});
        let test = TestVault::new("test", original.clone());
        let backup = crate::backup::create_backup_file(&test.state, "manual").unwrap();
        fs::copy(&backup.path, test.root.join(&backup.file_name)).unwrap();
        save_data(&json!({"assets": original["assets"], "settings": {"backupDirectory": test.root.join(".")}}), &test.state).unwrap();
        let alias = "ledger-20261003-000000-live-alias.db";
        fs::hard_link(test.state.db_path().unwrap(), test.root.join(alias)).unwrap();
        let listed = crate::backup::list_backup_files(&test.state).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, backup.file_name);
        for name in ["assets.db", alias, "../assets.db", "ledger-invalid-manual.db"] {
            assert!(crate::backup::restore_backup(&test.state, name, None).is_err());
        }
        assert!(crate::backup::check_backup_destination(&test.state, &test.root.join(".")).is_err());
        #[cfg(windows)]
        assert!(crate::backup::check_backup_destination(&test.state, Path::new(&test.root.to_string_lossy().to_uppercase())).is_err());
        assert!(crate::backup::create_backup_file(&test.state, "manual").is_err());
        assert_eq!(read_unlocked(&test.state).unwrap()["assets"], original["assets"]);
        assert!(test.state.db_path().unwrap().is_file());
    }

    #[test]
    fn vault_mutations_reject_overlap_and_can_retry() {
        let original = json!({"assets": [{"host": "original"}]});
        let test = TestVault::new("test", original.clone());
        let backup = crate::backup::create_backup_file(&test.state, "manual").unwrap();
        let guard = test.state.begin_operation().unwrap();
        std::thread::scope(|scope| {
            let operations = [
                scope.spawn(|| save_data(&json!({"assets": []}), &test.state).map(|_| ())),
                scope.spawn(|| crate::backup::restore_backup(&test.state, &backup.file_name, None).map(|_| ())),
                scope.spawn(|| reinitialize(&test.state, "new").map(|_| ())),
                scope.spawn(|| change_password(&test.state, "test", "new")),
            ];
            for operation in operations { assert!(operation.join().unwrap().unwrap_err().contains("正在保存")); }
        });
        drop(guard);
        assert_eq!(read_unlocked(&test.state).unwrap(), original);
        save_data(&json!({"assets": []}), &test.state).unwrap();
        assert_eq!(crate::backup::restore_backup(&test.state, &backup.file_name, None).unwrap(), original);
        assert!(test.state.begin_operation().is_ok());
    }

    #[test]
    fn lock_waits_for_mutation_then_clears_key() {
        let test = TestVault::new("test", json!({"assets": []}));
        let guard = test.state.begin_operation().unwrap();
        std::thread::scope(|scope| {
            let (started_send, started_receive) = std::sync::mpsc::channel();
            let (done_send, done_receive) = std::sync::mpsc::channel();
            let state = &test.state;
            scope.spawn(move || { started_send.send(()).unwrap(); lock_vault(state).unwrap(); done_send.send(()).unwrap(); });
            started_receive.recv().unwrap();
            assert!(done_receive.recv_timeout(std::time::Duration::from_millis(30)).is_err());
            drop(guard);
            done_receive.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        });
        assert!(read_unlocked(&test.state).is_err());
    }

    #[test]
    fn lock_clears_key_after_operation_mutex_is_poisoned() {
        let test = TestVault::new("test", json!({"assets": []}));
        let _ = std::panic::catch_unwind(|| {
            let _guard = test.state.operation.lock().unwrap();
            panic!("isolated poisoned operation");
        });
        lock_vault(&test.state).unwrap();
        assert!(test.state.key.lock().unwrap().is_none());
        assert!(read_unlocked(&test.state).is_err());
        assert!(save_data(&json!({"assets": []}), &test.state).is_err());
    }

    #[test]
    fn lock_clears_key_after_key_mutex_is_poisoned() {
        let test = TestVault::new("test", json!({"assets": []}));
        let _ = std::panic::catch_unwind(|| {
            let _guard = test.state.key.lock().unwrap();
            panic!("isolated poisoned key");
        });
        lock_vault(&test.state).unwrap();
        assert!(test.state.key.lock().unwrap_or_else(|error| error.into_inner()).is_none());
        assert!(read_unlocked(&test.state).is_err());
    }

    #[test]
    fn worker_command_queue_waits_for_reads_before_saving() {
        let test = TestVault::new("test", json!({"assets": []}));
        let command = test.state.wait_for_command().unwrap();
        let read = test.state.wait_for_operation().unwrap();
        let next = json!({"assets": [{"id": "queued", "host": "saved"}]});
        std::thread::scope(|scope| {
            let (started_send, started_receive) = std::sync::mpsc::channel();
            let (done_send, done_receive) = std::sync::mpsc::channel();
            let state = &test.state;
            let value = &next;
            scope.spawn(move || {
                started_send.send(()).unwrap();
                let _command = state.wait_for_command().unwrap();
                done_send.send(save_data(value, state)).unwrap();
            });
            started_receive.recv().unwrap();
            assert!(done_receive.recv_timeout(std::time::Duration::from_millis(30)).is_err());
            drop(read);
            drop(command);
            done_receive.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
        });
        assert_eq!(read_unlocked(&test.state).unwrap(), next);
    }

    #[test]
    fn password_change_queued_after_lock_never_reopens_vault() {
        let test = TestVault::new("old", json!({"assets": []}));
        lock_vault(&test.state).unwrap();
        assert!(change_password(&test.state, "old", "new").unwrap_err().contains("尚未解锁"));
        assert!(!test.state.is_unlocked().unwrap());
        assert!(test.unlocks_with("old"));
        assert!(!test.unlocks_with("new"));
    }
    #[test]
    fn legacy_ciphertext_is_backed_up_before_migration_and_aad_is_authenticated() {
        let original = json!({"version":3,"assets":[],"history":[]}); let test = TestVault::new("old", original.clone());
        let key = derive_key("old", &[5_u8; 16]).unwrap(); let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap(); let nonce = [7_u8; 12];
        let legacy = cipher.encrypt(&Nonce::try_from(nonce.as_slice()).unwrap(), serde_json::to_vec(&original).unwrap().as_slice()).unwrap();
        open(&test.state).unwrap().execute("UPDATE vault SET nonce=?1,ciphertext=?2", params![nonce.as_slice(), legacy]).unwrap();
        assert_eq!(unlock_data(&test.state, "old").unwrap(), original);
        let next = json!({"version":4,"assets":[],"history":[]}); save_unlocked(&next, &test.state).unwrap();
        let backups = crate::backup::list_backup_files(&test.state).unwrap(); assert_eq!(backups.len(), 1); assert_eq!(backups[0].kind, "pre-schema");
        assert_eq!(read_backup_data(&test.state, Path::new(&backups[0].path), Some("old")).unwrap(), original);
        let (_, nonce, ciphertext) = read_envelope(&open(&test.state).unwrap()).unwrap(); assert!(ciphertext.starts_with(ENVELOPE_HEADER));
        assert!(cipher.decrypt(&Nonce::try_from(nonce.as_slice()).unwrap(), &ciphertext[ENVELOPE_HEADER.len()..]).is_err(), "新密文不可去掉上下文后作为旧格式解密");
    }
    #[test]
    fn failed_migration_backup_preserves_the_saved_envelope() {
        let test = TestVault::new("old", json!({"assets":[],"history":[]})); let blocked = test.root.join("blocked"); fs::write(&blocked, b"file").unwrap();
        save_unlocked(&json!({"version":3,"assets":[],"settings":{"backupDirectory":blocked}}), &test.state).unwrap();
        unlock_data(&test.state, "old").unwrap(); let before = read_envelope(&open(&test.state).unwrap()).unwrap();
        assert!(save_unlocked(&json!({"version":4,"assets":[]}), &test.state).is_err());
        assert_eq!(read_envelope(&open(&test.state).unwrap()).unwrap(), before);
    }
    #[test]
    fn failed_password_rollback_locks_instead_of_saving_with_a_stale_key() {
        let test = TestVault::new("old", json!({"assets":[],"history":[]}));
        let connection = open(&test.state).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_rollback BEFORE UPDATE ON vault WHEN NEW.salt = X'05050505050505050505050505050505' BEGIN SELECT RAISE(ABORT, 'rollback failure'); END;").unwrap();
        REPLACEMENT_FAILURE.with(|remaining| remaining.set(Some(0)));
        assert!(change_password(&test.state, "old", "new").is_err());
        assert!(!test.state.is_unlocked().unwrap(), "回滚失败必须清除会话密钥，阻止旧密钥配新salt写盘");
        assert!(save_unlocked(&json!({"assets":[],"history":[]}), &test.state).is_err());
        assert!(test.unlocks_with("new"), "提交后的数据仍可用新密码打开");
    }
    #[test]
    fn backup_replacement_failure_restores_original_files_and_key() {
        let test = TestVault::new("old", json!({"assets":[],"history":[]}));
        let first = crate::backup::create_backup_file(&test.state, "manual").unwrap();
        let bytes = fs::read(&first.path).unwrap();
        REPLACEMENT_FAILURE.with(|remaining| remaining.set(Some(1)));
        assert!(change_password(&test.state, "old", "new").is_err());
        assert_eq!(fs::read(&first.path).unwrap(), bytes);
        assert_eq!(read_unlocked(&test.state).unwrap()["assets"], json!([]));
        assert!(test.unlocks_with("old")); assert!(!test.unlocks_with("new"));
    }
    #[test]
    fn password_verification_never_changes_data_or_unlocks_a_locked_session() {
        let test = TestVault::new("right", json!({"assets":[],"history":[]})); let before = read_envelope(&open(&test.state).unwrap()).unwrap();
        assert!(verify_password(&test.state, "wrong").is_err()); assert!(verify_password(&test.state, "right").is_ok());
        assert_eq!(read_envelope(&open(&test.state).unwrap()).unwrap(), before); lock_vault(&test.state).unwrap();
        assert!(verify_password(&test.state, "right").is_err()); assert!(!test.state.is_unlocked().unwrap());
    }
}
