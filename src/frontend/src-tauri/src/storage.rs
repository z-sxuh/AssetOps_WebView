use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    data_directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search_hotkey: Option<String>,
}

fn config_path(install_directory: &Path) -> PathBuf {
    install_directory.join("config.json")
}

fn read_config(install_directory: &Path) -> Result<AppConfig, String> {
    let path = config_path(install_directory);
    if !path.is_file() {
        return Ok(AppConfig {
            data_directory: "data".to_owned(),
            search_hotkey: None,
        });
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("config.json 格式错误：{error}"))
}

pub fn read_search_hotkey(install_directory: &Path) -> Result<String, String> {
    Ok(read_config(install_directory)?
        .search_hotkey
        .unwrap_or_else(|| "F4".to_owned()))
}

pub fn save_search_hotkey(install_directory: &Path, hotkey: &str) -> Result<(), String> {
    let mut config = read_config(install_directory)?;
    config.search_hotkey = Some(hotkey.to_owned());
    let temporary = install_directory.join("config.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, config_path(install_directory)).map_err(|error| error.to_string())
}

pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    path.components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect()
}

pub(crate) fn data_directory(database: &Path) -> Result<&Path, String> {
    let parent = database.parent().ok_or("无法定位数据目录")?;
    if parent.file_name().is_some_and(|name| name == "database") {
        parent.parent().ok_or_else(|| "无法定位数据目录".to_owned())
    } else {
        Ok(parent)
    }
}

pub(crate) fn checkpoint_database(connection: &rusqlite::Connection) -> Result<(), String> {
    let busy: i64 = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if busy != 0 { return Err("数据库仍被占用，请结束其他数据操作后重试".to_owned()); }
    Ok(())
}

pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::OpenOptions::new().write(true).open(source).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(())
    }
    #[cfg(not(windows))]
    { fs::rename(source, destination).map_err(|error| error.to_string()) }
}

pub(crate) fn database_path(directory: &Path) -> Result<PathBuf, String> {
    let legacy = directory.join("assets.db");
    let database = directory.join("database").join("assets.db");
    if legacy.exists() && database.exists() {
        return Err("旧库与 database/assets.db 同时存在，请先核对数据，应用不会覆盖任一数据库".to_owned());
    }
    fs::create_dir_all(database.parent().ok_or("无法定位数据库目录")?).map_err(|error| error.to_string())?;
    if legacy.exists() {
        let connection = rusqlite::Connection::open_with_flags(&legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|error| error.to_string())?;
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        if integrity != "ok" { return Err(format!("旧数据库校验失败，已保留原文件：{integrity}")); }
        checkpoint_database(&connection)?;
        drop(connection);
        fs::rename(&legacy, &database).map_err(|error| format!("数据库目录迁移失败，已保留旧库：{error}"))?;
    }
    Ok(database)
}

pub fn resolve_data_directory(install_directory: &Path) -> Result<PathBuf, String> {
    let path = config_path(install_directory);
    if !path.is_file() {
        let config = AppConfig {
            data_directory: "data".to_owned(),
            search_hotkey: None,
        };
        fs::write(
            &path,
            serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        return Ok(normalize_path(&install_directory.join("data")));
    }
    let config: AppConfig =
        serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("config.json 格式错误：{error}"))?;
    let configured = PathBuf::from(config.data_directory);
    Ok(normalize_path(&if configured.is_absolute() {
        configured
    } else {
        install_directory.join(configured)
    }))
}

#[cfg(test)]
mod tests {
    use super::{read_search_hotkey, resolve_data_directory, save_search_hotkey};
    use crate::{backup, vault::{self, tests::TestVault}};
    use serde_json::json;

    #[test]
    fn database_layout_preserves_encryption_and_backup_root() {
        let data = json!({"assets": [{"host": "kept"}], "settings": {}});
        let test = TestVault::new("test", data.clone());
        let backup = backup::create_backup_file(&test.state, "manual").unwrap();
        let path = super::database_path(&test.root).unwrap();
        assert_eq!(path, test.root.join("database/assets.db"));
        assert!(!test.root.join("assets.db").exists());
        assert_eq!(super::database_path(&test.root).unwrap(), path);
        test.state.set_db_path(path.clone()).unwrap();
        assert_eq!(vault::read_unlocked(&test.state).unwrap(), data);
        assert_eq!(backup::backup_directory(&test.state).unwrap(), test.root.join("backups"));
        assert!(backup::same_file(std::path::Path::new(&backup::list_backup_files(&test.state).unwrap()[0].path), std::path::Path::new(&backup.path)).unwrap());
        assert!(backup::check_backup_destination(&test.state, &test.root).is_err());
        assert!(backup::check_backup_destination(&test.state, path.parent().unwrap()).is_err());
        backup::create_backup_file(&test.state, "after-layout").unwrap();
    }

    #[test]
    fn database_layout_checkpoints_legacy_wal() {
        let test = TestVault::new("test", json!({"assets": []}));
        let connection = vault::open(&test.state).unwrap();
        connection.execute_batch("PRAGMA wal_autocheckpoint=0; CREATE TABLE layout_marker(value); INSERT INTO layout_marker VALUES(42);").unwrap();
        let root = test.root.join("wal-fixture");
        std::fs::create_dir(&root).unwrap();
        std::fs::copy(test.root.join("assets.db"), root.join("assets.db")).unwrap();
        std::fs::copy(test.root.join("assets.db-wal"), root.join("assets.db-wal")).unwrap();
        let path = super::database_path(&root).unwrap();
        let migrated = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(migrated.query_row("SELECT value FROM layout_marker", [], |row| row.get::<_, i64>(0)).unwrap(), 42);
    }

    #[test]
    fn database_layout_never_overwrites_conflicting_or_invalid_files() {
        let test = TestVault::new("test", json!({"assets": []}));
        std::fs::create_dir(test.root.join("database")).unwrap();
        let target = test.root.join("database/assets.db");
        std::fs::write(&target, b"existing database").unwrap();
        assert!(super::database_path(&test.root).unwrap_err().contains("同时存在"));
        assert_eq!(std::fs::read(&target).unwrap(), b"existing database");
        assert!(test.root.join("assets.db").is_file());
        let invalid = test.root.join("invalid-fixture");
        std::fs::create_dir(&invalid).unwrap();
        std::fs::write(invalid.join("assets.db"), b"invalid database").unwrap();
        assert!(super::database_path(&invalid).is_err());
        assert_eq!(std::fs::read(invalid.join("assets.db")).unwrap(), b"invalid database");
        assert!(!invalid.join("database/assets.db").exists());
    }
    #[test]
    fn configured_dot_directory_is_normalized() {
        let root = std::env::temp_dir().join(format!("assetops-path-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("config.json"), r#"{"dataDirectory":"./data"}"#).unwrap();
        let path = resolve_data_directory(&root).unwrap();
        assert_eq!(path, root.join("data"));
        assert!(!path.to_string_lossy().contains(r"\.\"));
        std::fs::remove_file(root.join("config.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn search_hotkey_keeps_data_directory_and_explicit_disable() {
        let directory = std::env::var_os("ASSETOPS_VERIFY_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = directory.join(format!("assetops-hotkey-config-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("config.json"), r#"{"dataDirectory":"./custom-data"}"#).unwrap();
        assert_eq!(read_search_hotkey(&root).unwrap(), "F4");
        save_search_hotkey(&root, "Ctrl+Alt+S").unwrap();
        assert_eq!(read_search_hotkey(&root).unwrap(), "Ctrl+Alt+S");
        assert_eq!(resolve_data_directory(&root).unwrap(), root.join("custom-data"));
        save_search_hotkey(&root, "").unwrap();
        assert_eq!(read_search_hotkey(&root).unwrap(), "");
        std::fs::remove_file(root.join("config.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
