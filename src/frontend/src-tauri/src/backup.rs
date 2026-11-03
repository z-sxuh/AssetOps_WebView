use crate::vault::{self, VaultState};
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub created_at: String,
    pub sha256: String,
    pub integrity: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    pub keep_last: usize,
    pub keep_daily: usize,
    pub keep_weekly: usize,
    pub keep_monthly: usize,
    pub keep_yearly: usize,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            keep_last: 20,
            keep_daily: 7,
            keep_weekly: 8,
            keep_monthly: 6,
            keep_yearly: 2,
        }
    }
}

pub(crate) fn backup_directory(state: &VaultState) -> Result<PathBuf, String> {
    #[cfg(test)]
    DIRECTORY_READS.with(|reads| reads.set(reads.get() + 1));
    let database_path = state.db_path()?;
    let data_directory = crate::storage::data_directory(&database_path)?;
    let data = vault::read_unlocked(state)?;
    let configured = data
        .get("settings")
        .and_then(|settings| settings.get("backupDirectory"))
        .and_then(Value::as_str)
        .unwrap_or("data\\backups");
    let directory = if configured.is_empty()
        || matches!(
            configured,
            "data\\backups" | "data/backups" | "backups" | "./data/backups" | "./backups"
        ) {
        data_directory.join("backups")
    } else {
        let configured = PathBuf::from(configured);
        if configured.is_absolute() {
            configured
        } else {
            data_directory.join(configured)
        }
    };
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(crate::storage::normalize_path(&directory))
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn backup_copy_to_directory(window: tauri::WebviewWindow,
    new_directory: String,
    state: tauri::State<'_, VaultState>,
) -> Result<String, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    let requested = PathBuf::from(new_directory.trim());
    if !requested.is_absolute() {
        return Err("请输入备份目录的完整绝对路径".to_owned());
    }
    fs::create_dir_all(&requested).map_err(|error| error.to_string())?;
    let destination = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    check_backup_destination(&state, &destination)?;
    let source = backup_directory(&state)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if destination == source {
        return Err("新备份目录与当前目录相同".to_owned());
    }
    let backups = list_backup_files(&state)?;
    if backups
        .iter()
        .any(|backup| destination.join(&backup.file_name).exists())
    {
        return Err("目标目录存在同名备份文件，请选择其他目录".to_owned());
    }
    let mut copied = Vec::new();
    for backup in backups {
        let target = destination.join(&backup.file_name);
        let result = fs::copy(&backup.path, &target)
            .map_err(|error| error.to_string())
            .and_then(|_| {
                if sha256_file(&target)? != backup.sha256 {
                    return Err("备份副本校验失败".to_owned());
                }
                Ok(())
            });
        if let Err(error) = result {
            let _ = fs::remove_file(&target);
            for path in copied {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        copied.push(target);
    }
    Ok(destination.to_string_lossy().into_owned())
}

fn sanitize_kind(kind: &str) -> String {
    let sanitized: String = kind
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(32)
        .collect();
    if sanitized.is_empty() {
        "manual".to_owned()
    } else {
        sanitized
    }
}

fn is_backup_name(file_name: &str) -> bool {
    let Some(stem) = file_name.strip_prefix("ledger-").and_then(|name| name.strip_suffix(".db")) else { return false; };
    let Some((timestamp, kind)) = stem.get(..15).zip(stem.get(16..)) else { return false; };
    stem.as_bytes().get(15) == Some(&b'-')
        && NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S").is_ok()
        && !kind.is_empty()
        && kind.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) fn check_backup_destination(state: &VaultState, directory: &Path) -> Result<(), String> {
    let database = state.db_path()?;
    let data_directory = crate::storage::data_directory(&database)?.canonicalize().map_err(|error| error.to_string())?;
    let database_directory = database.parent().ok_or("无法定位数据库目录")?;
    if same_file(directory, &data_directory)? || same_file(directory, database_directory)? {
        return Err("备份目录不能与数据目录相同，请选择独立目录".to_owned());
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn same_file(left: &Path, right: &Path) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS};
    let identity = |path: &Path| -> Result<(u32, u32, u32), String> {
        let file = fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path).map_err(|error| error.to_string())?;
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok((information.dwVolumeSerialNumber, information.nFileIndexHigh, information.nFileIndexLow))
    };
    Ok(identity(left)? == identity(right)?)
}

#[cfg(not(windows))]
pub(crate) fn same_file(left: &Path, right: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let left = fs::metadata(left).map_err(|error| error.to_string())?;
    let right = fs::metadata(right).map_err(|error| error.to_string())?;
    Ok((left.dev(), left.ino()) == (right.dev(), right.ino()))
}

fn safe_backup_path(state: &VaultState, file_name: &str) -> Result<PathBuf, String> {
    if !is_backup_name(file_name) {
        return Err("备份文件名无效".to_owned());
    }
    let directory = backup_directory(state)?.canonicalize().map_err(|error| error.to_string())?;
    safe_backup_path_in(&directory, &state.db_path()?, file_name)
}

fn safe_backup_path_in(directory: &Path, database: &Path, file_name: &str) -> Result<PathBuf, String> {
    if !is_backup_name(file_name) {
        return Err("备份文件名无效".to_owned());
    }
    let path = directory.join(file_name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "备份文件不存在".to_owned())?;
    if !metadata.is_file() || metadata.file_type().is_symlink()
        || path.canonicalize().map_err(|error| error.to_string())?.parent() != Some(directory)
        || same_file(&path, database)?
    {
        return Err("该文件不是独立备份，不能操作".to_owned());
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn database_integrity(path: &Path) -> Result<bool, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(result.eq_ignore_ascii_case("ok"))
}

fn backup_kind(file_name: &str) -> String {
    let kind = file_name
        .strip_prefix("ledger-")
        .and_then(|name| name.strip_suffix(".db"))
        .and_then(|name| name.get(16..))
        .unwrap_or("unknown")
        .trim_start_matches('-');
    if let Some((base, suffix)) = kind.rsplit_once('-') {
        if matches!(base, "manual" | "scheduled" | "startup" | "pre-import" | "pre-schema" | "pre-restore" | "password-change" | "reinitialize")
            && !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            return base.to_owned();
        }
    }
    kind.to_owned()
}

fn backup_metadata(path: &Path) -> Result<BackupInfo, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("备份文件名不是有效 UTF-8")?
        .to_owned();
    let created_at: DateTime<Local> = file_name
        .strip_prefix("ledger-")
        .and_then(|name| name.get(..15))
        .and_then(|timestamp| NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S").ok())
        .and_then(|date| Local.from_local_datetime(&date).earliest())
        .unwrap_or_else(|| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into());
    Ok(BackupInfo {
        path: path.to_string_lossy().into_owned(),
        kind: backup_kind(&file_name),
        file_name,
        size: metadata.len(),
        created_at: created_at.to_rfc3339(),
        sha256: String::new(),
        integrity: "unchecked".into(),
    })
}

fn backup_info(path: &Path) -> Result<BackupInfo, String> {
    let mut info = backup_metadata(path)?;
    info.integrity = match database_integrity(path) { Ok(true) => "ok", Ok(false) => "failed", Err(_) => "unreadable" }.into();
    info.sha256 = sha256_file(path)?;
    Ok(info)
}

pub(crate) fn create_backup_file(state: &VaultState, kind: &str) -> Result<BackupInfo, String> {
    let connection = vault::open(state)?;
    crate::storage::checkpoint_database(&connection)?;
    drop(connection);

    let directory = backup_directory(state)?;
    check_backup_destination(state, &directory)?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let kind = sanitize_kind(kind);
    let mut path = directory.join(format!("ledger-{timestamp}-{kind}.db"));
    let mut suffix = 1_u64;
    while path.exists() {
        path = directory.join(format!("ledger-{timestamp}-{kind}-{suffix}.db"));
        suffix += 1;
    }
    let result = (|| {
        fs::copy(state.db_path()?, &path).map_err(|error| error.to_string())?;
        let info = backup_info(&path)?;
        if info.integrity != "ok" { return Err("备份完整性校验失败".to_owned()); }
        Ok(info)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

#[tauri::command(async)]
pub fn backup_create(window: tauri::WebviewWindow,
    kind: String,
    state: tauri::State<'_, VaultState>,
) -> Result<BackupInfo, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    let created = create_backup_file(&state, &kind)?;
    let data = vault::read_unlocked(&state)?;
    let (policy, scheduled_policy) = saved_retention_policies(&data);
    for backup in retention_deletions(&list_backup_files(&state)?, policy, scheduled_policy) {
        move_backup_to_trash(safe_backup_path(&state, &backup.file_name)?)?;
    }
    Ok(created)
}

fn saved_retention_policies(data: &Value) -> (RetentionPolicy, RetentionPolicy) {
    let settings = data.get("settings");
    let automatic = settings.and_then(|settings| settings.get("backupRetention"));
    let scheduled = settings.and_then(|settings| settings.get("scheduledBackupRetention")).or(automatic);
    (retention_policy(automatic), retention_policy(scheduled))
}

fn retention_policy(retention: Option<&Value>) -> RetentionPolicy {
    let count = |key: &str, fallback: usize| {
        retention
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(fallback)
    };
    RetentionPolicy {
        keep_last: count("recent", 20),
        keep_daily: count("daily", 7),
        keep_weekly: count("weekly", 8),
        keep_monthly: count("monthly", 6),
        keep_yearly: count("yearly", 2),
    }
}

pub(crate) fn list_backup_files(state: &VaultState) -> Result<Vec<BackupInfo>, String> {
    list_backup_entries(state, true)
}

fn list_backup_entries(state: &VaultState, verify: bool) -> Result<Vec<BackupInfo>, String> {
    let directory = backup_directory(state)?.canonicalize().map_err(|error| error.to_string())?;
    let database = state.db_path()?;
    let mut backups = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().and_then(|name| safe_backup_path_in(&directory, &database, name).ok()))
        .map(|path| if verify { backup_info(&path) } else { backup_metadata(&path) })
        .collect::<Result<Vec<_>, _>>()?;
    backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(backups)
}

#[tauri::command(async)]
pub fn backup_list(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<Vec<BackupInfo>, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    read_backup_list(&state)
}

fn read_backup_list(state: &VaultState) -> Result<Vec<BackupInfo>, String> {
    let _operation = state.wait_for_operation()?;
    list_backup_entries(state, false)
}

#[tauri::command(async)]
pub fn backup_restore(window: tauri::WebviewWindow,
    file_name: String,
    password: Option<String>,
    state: tauri::State<'_, VaultState>,
) -> Result<Value, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let password = password.map(Zeroizing::new);
    restore_backup(&state, &file_name, password.as_ref().map(|value| value.as_str()))
}

pub(crate) fn restore_backup(
    state: &VaultState,
    file_name: &str,
    password: Option<&str>,
) -> Result<Value, String> {
    let _operation = state.begin_operation()?;
    let source = safe_backup_path(state, file_name)?;
    if !source.is_file() {
        return Err("备份文件不存在".to_owned());
    }
    if !database_integrity(&source)? {
        return Err("备份数据库完整性校验失败".to_owned());
    }
    let mut data = vault::read_backup_data(state, &source, password)?;
    if let Some(settings) = vault::read_unlocked(state)?.get("settings") { data["settings"] = settings.clone(); }
    create_backup_file(state, "pre-restore")?;
    vault::save_unlocked(&data, state)?;
    Ok(data)
}

#[tauri::command(async)]
pub fn backup_delete(window: tauri::WebviewWindow, file_name: String, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    let path = safe_backup_path(&state, &file_name)?;
    if !path.is_file() {
        return Err("备份文件不存在".to_owned());
    }
    move_backup_to_trash(path)
}

fn move_backup_to_trash(path: impl AsRef<Path>) -> Result<(), String> {
    trash::delete(path).map_err(|error| format!("无法将备份移至 Windows 回收站：{error}"))
}

fn retention_deletions(backups: &[BackupInfo], policy: RetentionPolicy, scheduled_policy: RetentionPolicy) -> Vec<BackupInfo> {
    let mut deletions = retention_pool_deletions(backups, policy, false);
    deletions.extend(retention_pool_deletions(backups, scheduled_policy, true));
    deletions
}

fn retention_pool_deletions(backups: &[BackupInfo], policy: RetentionPolicy, scheduled: bool) -> Vec<BackupInfo> {
    // 手动及关键操作前备份受到保护；自动备份与定时备份各自计算留存名额。
    let mut ordered = backups.iter().filter(|backup| backup.integrity == "ok" && !matches!(backup.kind.as_str(), "manual" | "password-change" | "reinitialize" | "pre-schema") && (backup.kind == "scheduled") == scheduled).cloned().collect::<Vec<_>>();
    ordered.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let mut keep = HashSet::new();
    for backup in ordered.iter().take(policy.keep_last) {
        keep.insert(backup.file_name.clone());
    }

    let parsed = ordered
        .iter()
        .filter_map(|backup| {
            DateTime::parse_from_rfc3339(&backup.created_at)
                .ok()
                .map(|date| (backup, date))
        })
        .collect::<Vec<_>>();
    let policies = [
        (policy.keep_daily, "day"),
        (policy.keep_weekly, "week"),
        (policy.keep_monthly, "month"),
        (policy.keep_yearly, "year"),
    ];
    for (limit, group) in policies {
        let mut groups = HashSet::new();
        for (backup, date) in &parsed {
            let key = match group {
                "day" => format!("{}-{}-{}", date.year(), date.month(), date.day()),
                "week" => format!("{}-{}", date.iso_week().year(), date.iso_week().week()),
                "month" => format!("{}-{}", date.year(), date.month()),
                _ => date.year().to_string(),
            };
            if groups.contains(&key) {
                continue;
            }
            if groups.len() >= limit {
                break;
            }
            groups.insert(key);
            keep.insert(backup.file_name.clone());
        }
    }

    ordered
        .into_iter()
        .filter(|backup| backup.integrity == "ok" && !keep.contains(&backup.file_name))
        .collect()
}

#[tauri::command(async)]
pub fn backup_simulate_cleanup(window: tauri::WebviewWindow,
    policy: Option<RetentionPolicy>,
    scheduled_policy: Option<RetentionPolicy>,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<BackupInfo>, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.wait_for_operation()?;
    let backups = list_backup_files(&state)?;
    let policy = policy.unwrap_or_default();
    Ok(retention_deletions(&backups, policy, scheduled_policy.unwrap_or(policy)))
}

#[cfg(test)]
thread_local! {
    static DIRECTORY_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::{
        backup_info, move_backup_to_trash, read_backup_list, retention_deletions, BackupInfo, RetentionPolicy,
    };

    // Keep the former implementation here for result and work-count comparisons on synthetic data.
    fn reference_backup_list(state: &crate::vault::VaultState) -> Result<Vec<BackupInfo>, String> {
        let mut backups = std::fs::read_dir(super::backup_directory(state)?)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str().and_then(|name| super::safe_backup_path(state, name).ok()))
            .map(|path| backup_info(&path))
            .collect::<Result<Vec<_>, _>>()?;
        backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(backups)
    }

    fn counted_list(state: &crate::vault::VaultState, list: fn(&crate::vault::VaultState) -> Result<Vec<BackupInfo>, String>) -> (Vec<BackupInfo>, usize) {
        super::DIRECTORY_READS.with(|reads| reads.set(0));
        let backups = list(state).unwrap();
        (backups, super::DIRECTORY_READS.with(|reads| reads.get()))
    }

    #[test]
    fn enumeration_resolves_directory_once_and_preserves_results_and_validation() {
        let test = crate::vault::tests::TestVault::new("test", serde_json::json!({"assets": []}));
        let created = super::create_backup_file(&test.state, "manual").unwrap();
        let directory = super::backup_directory(&test.state).unwrap();
        std::fs::copy(&created.path, directory.join("ledger-20260101-080000-scheduled.db")).unwrap();
        std::fs::write(directory.join("ledger-20260102-080000-corrupt.db"), b"synthetic damaged database").unwrap();
        std::fs::write(directory.join("ledger-invalid-manual.db"), b"ignored").unwrap();
        std::fs::create_dir(directory.join("ledger-20260103-080000-directory.db")).unwrap();
        let (expected, reference_reads) = counted_list(&test.state, reference_backup_list);
        let (actual, reads) = counted_list(&test.state, super::list_backup_files);
        assert_eq!(serde_json::to_value(&actual).unwrap(), serde_json::to_value(&expected).unwrap());
        assert_eq!(actual.len(), 3);
        assert_eq!(reads, 1);
        assert_eq!(reference_reads, 5); // Initial read, three files, and one rejected directory.
        assert!(actual.iter().any(|backup| backup.integrity == "unreadable" && backup.sha256.len() == 64));
        assert_eq!(actual.iter().filter(|backup| backup.integrity == "ok").count(), 2);
    }

    #[test]
    fn resolved_paths_remain_local_and_the_next_operation_uses_current_settings() {
        let test = crate::vault::tests::TestVault::new("test", serde_json::json!({"assets": []}));
        let created = super::create_backup_file(&test.state, "manual").unwrap();
        let directory = super::backup_directory(&test.state).unwrap().canonicalize().unwrap();
        let database = test.state.db_path().unwrap();
        let alternate = test.root.join("alternate-backups");
        std::fs::create_dir(&alternate).unwrap();
        crate::vault::save_data(&serde_json::json!({"assets": [], "settings": {"backupDirectory": alternate}}), &test.state).unwrap();
        assert_eq!(super::safe_backup_path_in(&directory, &database, &created.file_name).unwrap(), std::path::Path::new(&created.path).canonicalize().unwrap());
        assert!(super::safe_backup_path(&test.state, &created.file_name).is_err());
        assert!(super::list_backup_files(&test.state).unwrap().is_empty());
        let moved_name = "ledger-20260104-080000-new-directory.db";
        std::fs::copy(&created.path, alternate.join(moved_name)).unwrap();
        assert_eq!(super::list_backup_files(&test.state).unwrap()[0].file_name, moved_name);
        assert_eq!(super::safe_backup_path(&test.state, moved_name).unwrap().parent(), Some(alternate.canonicalize().unwrap().as_path()));
        for invalid in ["../assets.db", "assets.db", "ledger-invalid-manual.db", "ledger-20260101-080000-../escape.db"] {
            assert!(super::safe_backup_path_in(&directory, &database, invalid).unwrap_err().contains("文件名无效"));
        }
        let alias = "ledger-20260105-080000-active-alias.db";
        std::fs::hard_link(&database, directory.join(alias)).unwrap();
        assert!(super::safe_backup_path_in(&directory, &database, alias).unwrap_err().contains("不是独立备份"));
        assert!(super::safe_backup_path_in(&directory, &directory.join(&created.file_name), &created.file_name).unwrap_err().contains("不是独立备份"));
    }

    #[test]
    #[cfg_attr(windows, ignore = "Requires Windows Developer Mode or SeCreateSymbolicLinkPrivilege")]
    fn enumeration_rejects_symbolic_links() {
        let test = crate::vault::tests::TestVault::new("test", serde_json::json!({"assets": []}));
        let created = super::create_backup_file(&test.state, "manual").unwrap();
        let directory = super::backup_directory(&test.state).unwrap().canonicalize().unwrap();
        let link = directory.join("ledger-20260106-080000-symlink.db");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&created.path, &link).unwrap();
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&created.path, &link).unwrap();
        assert!(super::safe_backup_path_in(&directory, &test.state.db_path().unwrap(), link.file_name().unwrap().to_str().unwrap()).unwrap_err().contains("不是独立备份"));
        let backups = super::list_backup_files(&test.state).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].file_name, created.file_name);
    }

    #[cfg(windows)]
    fn thread_cpu_time() -> std::time::Duration {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThread() -> *mut std::ffi::c_void;
            fn GetThreadTimes(thread: *mut std::ffi::c_void, created: *mut u64, exited: *mut u64, kernel: *mut u64, user: *mut u64) -> i32;
        }
        let (mut created, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
        assert_ne!(unsafe { GetThreadTimes(GetCurrentThread(), &mut created, &mut exited, &mut kernel, &mut user) }, 0);
        std::time::Duration::from_nanos((kernel + user) * 100)
    }

    #[test]
    #[ignore = "Synthetic A/B benchmark; run separately from UI frame capture"]
    #[cfg(windows)]
    fn synthetic_enumeration_benchmark() {
        use std::time::{Duration, Instant};
        let measure = |test: &crate::vault::tests::TestVault, data: &serde_json::Value, list: fn(&crate::vault::VaultState) -> Result<Vec<BackupInfo>, String>| {
            std::thread::scope(|scope| {
                let command = test.state.wait_for_command().unwrap();
                let operation = test.state.begin_operation().unwrap();
                let (started_send, started_receive) = std::sync::mpsc::channel();
                let queued_save = scope.spawn(move || {
                    let start = Instant::now();
                    started_send.send(()).unwrap();
                    let _command = test.state.wait_for_command().unwrap();
                    let wait = start.elapsed();
                    crate::vault::save_data(data, &test.state).unwrap();
                    wait
                });
                started_receive.recv().unwrap();
                let cpu = thread_cpu_time();
                let start = Instant::now();
                let (backups, reads) = counted_list(&test.state, list);
                let elapsed = start.elapsed();
                let cpu = thread_cpu_time() - cpu;
                drop(operation);
                drop(command);
                let wait = queued_save.join().unwrap();
                (backups, reads, elapsed, cpu, wait)
            })
        };
        let median = |values: &mut Vec<Duration>| { values.sort(); values[values.len() / 2].as_secs_f64() * 1000.0 };
        println!("payload_bytes,backups,variant,directory_decryptions,median_wall_ms,median_thread_cpu_ms,median_save_queue_ms");
        for payload in [16 * 1024, 1024 * 1024] {
            let data = serde_json::json!({"assets": [], "syntheticPayload": "x".repeat(payload)});
            let test = crate::vault::tests::TestVault::new("test", data.clone());
            let created = super::create_backup_file(&test.state, "synthetic").unwrap();
            let directory = super::backup_directory(&test.state).unwrap();
            for count in [1, 20, 100] {
                for index in 1..count {
                    let path = directory.join(format!("ledger-20260101-080000-synthetic-{index}.db"));
                    if !path.exists() { std::fs::copy(&created.path, path).unwrap(); }
                }
                let mut samples = [(Vec::new(), Vec::new(), Vec::new()), (Vec::new(), Vec::new(), Vec::new())];
                for round in 0..3 {
                    let mut outputs = Vec::new();
                    for variant in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                        let list = if variant == 0 { reference_backup_list } else { super::list_backup_files };
                        let (backups, reads, wall, cpu, wait) = measure(&test, &data, list);
                        assert_eq!(backups.len(), count);
                        assert_eq!(reads, if variant == 0 { count + 1 } else { 1 });
                        samples[variant].0.push(wall);
                        samples[variant].1.push(cpu);
                        samples[variant].2.push(wait);
                        outputs.push(serde_json::to_value(backups).unwrap());
                    }
                    assert_eq!(outputs[0], outputs[1]);
                }
                for (variant, (wall, cpu, wait)) in samples.iter_mut().enumerate() {
                    println!("{payload},{count},{},{},{:.3},{:.3},{:.3}", if variant == 0 { "before" } else { "after" }, if variant == 0 { count + 1 } else { 1 }, median(wall), median(cpu), median(wait));
                }
            }
        }
    }

    #[test]
    fn backup_list_waits_for_mutation_and_reads_completed_backup() {
        let test = crate::vault::tests::TestVault::new("test", serde_json::json!({"assets": []}));
        let guard = test.state.begin_operation().unwrap();
        std::thread::scope(|scope| {
            let (started_send, started_receive) = std::sync::mpsc::channel();
            let (done_send, done_receive) = std::sync::mpsc::channel();
            let state = &test.state;
            scope.spawn(move || { started_send.send(()).unwrap(); done_send.send(read_backup_list(state)).unwrap(); });
            started_receive.recv().unwrap();
            assert!(done_receive.recv_timeout(std::time::Duration::from_millis(30)).is_err());
            let created = super::create_backup_file(state, "manual").unwrap();
            drop(guard);
            let backups = done_receive.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(backups.len(), 1);
            assert_eq!(backups[0].file_name, created.file_name);
            assert_eq!(backups[0].integrity, "unchecked");
            assert!(backups[0].sha256.is_empty());
        });
    }

    #[test]
    fn backup_creation_date_comes_from_name_instead_of_copied_or_reencrypted_mtime() {
        let directory = std::env::temp_dir().join(format!(
            "assetops-backup-time-{}-{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("ledger-20260901-080000-scheduled.db");
        drop(rusqlite::Connection::open(&path).unwrap());
        let original = backup_info(&path).unwrap();
        assert!(original.created_at.starts_with("2026-09-01T08:00:00"));
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
            .unwrap();
        assert_eq!(backup_info(&path).unwrap().created_at, original.created_at);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn deleted_backup_can_be_restored_from_windows_recycle_bin() {
        let name = format!(
            "assetops-trash-test-{}-{}.db",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap()
        );
        let path = std::env::temp_dir().join(&name);
        std::fs::write(&path, b"synthetic-backup").unwrap();
        move_backup_to_trash(&path).unwrap();
        assert!(!path.exists());
        let item = trash::os_limited::list()
            .unwrap()
            .into_iter()
            .find(|item| item.name.to_string_lossy() == name)
            .expect("验证文件应存在于 Windows 回收站");
        assert_eq!(item.original_path(), path);
        trash::os_limited::restore_all([item]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"synthetic-backup");
        std::fs::remove_file(&path).unwrap();
    }

    fn backup(name: &str, date: &str) -> BackupInfo {
        BackupInfo {
            file_name: name.to_owned(),
            path: name.to_owned(),
            kind: "startup".to_owned(),
            size: 1,
            created_at: date.to_owned(),
            sha256: "hash".to_owned(),
            integrity: "ok".to_owned(),
        }
    }

    #[test]
    fn invalid_backups_do_not_consume_valid_retention_slots() {
        let none = RetentionPolicy { keep_last: 0, keep_daily: 0, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        for kind in ["startup", "scheduled"] {
            for field in 0..5 {
                let mut policy = none;
                match field {
                    0 => policy.keep_last = 1, 1 => policy.keep_daily = 1,
                    2 => policy.keep_weekly = 1, 3 => policy.keep_monthly = 1,
                    _ => policy.keep_yearly = 1,
                }
                let mut bad = backup("bad.db", "2026-10-29T12:00:00+08:00");
                bad.kind = kind.to_owned(); bad.integrity = "unreadable".to_owned();
                let mut good = backup("good.db", "2026-10-29T11:00:00+08:00");
                good.kind = kind.to_owned();
                let records = vec![bad, good];
                assert!(retention_deletions(&records, policy, policy).is_empty(), "{kind} rule {field}: invalid backup cannot consume a valid slot");
                assert_eq!(retention_deletions(&records, none, none).iter().map(|item| item.file_name.as_str()).collect::<Vec<_>>(), vec!["good.db"], "zero policy still retains invalid files for inspection");
            }
        }
    }

    #[test]
    fn retention_keeps_union_of_recent_and_time_buckets() {
        let backups = vec![
            backup("a.db", "2026-09-29T12:00:00+08:00"),
            backup("b.db", "2026-09-29T11:00:00+08:00"),
            backup("c.db", "2026-09-28T12:00:00+08:00"),
            backup("d.db", "2026-08-01T12:00:00+08:00"),
        ];
        let deletions = retention_deletions(
            &backups,
            RetentionPolicy {
                keep_last: 1,
                keep_daily: 2,
                keep_weekly: 0,
                keep_monthly: 0,
                keep_yearly: 0,
            },
            RetentionPolicy::default(),
        );
        let names = deletions
            .into_iter()
            .map(|backup| backup.file_name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["b.db", "d.db"]);
        let mut scheduled = backups;
        for backup in &mut scheduled { backup.kind = "scheduled".to_owned(); }
        let policy = RetentionPolicy { keep_last: 1, keep_daily: 2, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        assert_eq!(retention_deletions(&scheduled, RetentionPolicy::default(), policy).iter().map(|backup| backup.file_name.as_str()).collect::<Vec<_>>(), vec!["b.db", "d.db"]);
    }

    #[test]
    fn manual_backups_are_never_retention_candidates() {
        let mut manual = backup("manual.db", "2026-10-09T12:00:00+08:00");
        manual.kind = "manual".to_owned();
        let backups = vec![manual, backup("automatic.db", "2026-10-08T12:00:00+08:00")];
        let policy = RetentionPolicy { keep_last: 0, keep_daily: 0, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        assert_eq!(retention_deletions(&backups, policy, policy).iter().map(|item| item.file_name.as_str()).collect::<Vec<_>>(), vec!["automatic.db"]);
        let policy = RetentionPolicy { keep_last: 1, ..policy };
        assert!(retention_deletions(&backups, policy, policy).is_empty(), "manual does not consume the automatic recent slot");
    }

    #[test]
    fn automatic_and_scheduled_retention_have_independent_slots() {
        let mut scheduled = backup("scheduled.db", "2026-10-09T12:00:00+08:00");
        scheduled.kind = "scheduled".to_owned();
        let mut old_scheduled = backup("old-scheduled.db", "2026-10-06T12:00:00+08:00");
        old_scheduled.kind = "scheduled".to_owned();
        let backups = vec![scheduled, backup("recent.db", "2026-10-08T12:00:00+08:00"), backup("old.db", "2026-10-07T12:00:00+08:00"), old_scheduled];
        let policy = RetentionPolicy { keep_last: 1, keep_daily: 0, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        assert_eq!(retention_deletions(&backups, policy, policy).iter().map(|item| item.file_name.as_str()).collect::<Vec<_>>(), vec!["old.db", "old-scheduled.db"]);
        let none = RetentionPolicy { keep_last: 0, keep_daily: 0, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        let deleted = retention_deletions(&backups, policy, none);
        assert_eq!(deleted.iter().map(|item| item.file_name.as_str()).collect::<Vec<_>>(), vec!["old.db", "scheduled.db", "old-scheduled.db"]);
    }

    #[test]
    fn scheduled_retention_migrates_old_policy_and_preserves_explicit_policy() {
        let legacy = serde_json::json!({ "settings": { "backupRetention": { "recent": 3, "daily": 4, "weekly": 5, "monthly": 6, "yearly": 7 } } });
        let (automatic, scheduled) = super::saved_retention_policies(&legacy);
        assert_eq!([automatic.keep_last, automatic.keep_daily, automatic.keep_weekly, automatic.keep_monthly, automatic.keep_yearly], [3, 4, 5, 6, 7]);
        assert_eq!([scheduled.keep_last, scheduled.keep_daily, scheduled.keep_weekly, scheduled.keep_monthly, scheduled.keep_yearly], [3, 4, 5, 6, 7]);
        let mut current = legacy;
        current["settings"]["scheduledBackupRetention"] = serde_json::json!({ "recent": 0, "daily": 1, "weekly": 2, "monthly": 3, "yearly": 4 });
        let (automatic, scheduled) = super::saved_retention_policies(&current);
        assert_eq!(automatic.keep_last, 3);
        assert_eq!([scheduled.keep_last, scheduled.keep_daily, scheduled.keep_weekly, scheduled.keep_monthly, scheduled.keep_yearly], [0, 1, 2, 3, 4]);
    }

    #[test]
    fn duplicate_filename_suffix_preserves_retention_kind() {
        for kind in ["manual", "scheduled", "startup", "pre-import", "pre-schema", "pre-restore"] {
            assert_eq!(super::backup_kind(&format!("ledger-20261023-120000-{kind}-1.db")), kind);
        }
        assert_eq!(super::backup_kind("ledger-20261023-120000-custom-kind.db"), "custom-kind");
    }
    #[test]
    fn listing_defers_checks_but_restore_validates_before_writing() {
        let original = serde_json::json!({"version":4,"assets":[]}); let test = crate::vault::tests::TestVault::new("test", original.clone());
        let backup = super::create_backup_file(&test.state, "manual").unwrap(); let list = read_backup_list(&test.state).unwrap();
        assert_eq!(list[0].integrity, "unchecked"); assert!(list[0].sha256.is_empty());
        std::fs::write(&backup.path, b"corrupted backup").unwrap(); assert!(super::restore_backup(&test.state, &backup.file_name, None).is_err());
        assert_eq!(crate::vault::read_unlocked(&test.state).unwrap(), original);
    }
    #[test]
    fn restore_preserves_current_settings_and_restores_business_data() {
        let original = serde_json::json!({"version":4,"assets":[{"id":"a","name":"old"}],"settings":{"theme":"spring"}});
        let test = crate::vault::tests::TestVault::new("test", original.clone()); let backup = super::create_backup_file(&test.state, "manual").unwrap();
        let mut next = original.clone(); next["assets"][0]["name"] = serde_json::json!("new"); next["settings"] = serde_json::json!({"theme":"dark","backupDirectory":super::backup_directory(&test.state).unwrap()}); crate::vault::save_unlocked(&next, &test.state).unwrap();
        let restored = super::restore_backup(&test.state, &backup.file_name, None).unwrap(); assert_eq!(restored["settings"], next["settings"]); assert_eq!(restored["assets"], original["assets"]);
    }
    #[test]
    fn password_and_migration_backups_are_excluded_from_automatic_retention() {
        let policy = RetentionPolicy { keep_last: 0, keep_daily: 0, keep_weekly: 0, keep_monthly: 0, keep_yearly: 0 };
        let backups = ["password-change", "reinitialize", "pre-schema"].map(|kind| BackupInfo { file_name: format!("{kind}.db"), path: String::new(), kind: kind.into(), size: 1, created_at: "2026-10-29T00:00:00+08:00".into(), sha256: String::new(), integrity: "ok".into() });
        assert!(retention_deletions(&backups, policy, policy).is_empty());
        assert_eq!(super::backup_kind("ledger-20261029-120000-password-change-2.db"), "password-change");
    }
}
