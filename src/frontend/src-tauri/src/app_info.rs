use crate::vault::{self, VaultState};
use serde::Serialize;
use std::{fs, process::Command};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_directory: String,
    database_path: String,
    backup_directory: String,
    export_directory: String,
    database_size: u64,
    journal_mode: String,
    schema_version: i64,
    unlocked: bool,
}

#[tauri::command(async)]
pub fn app_info(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<AppInfo, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.wait_for_operation()?;
    let database_path = state.db_path()?;
    let connection = vault::open(&state)?;
    let journal_mode = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let database_size = fs::metadata(&database_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let data_directory = crate::storage::data_directory(&database_path)?
        .to_string_lossy()
        .into_owned();

    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").replace('+', "."),
        data_directory,
        database_path: database_path.to_string_lossy().into_owned(),
        backup_directory: crate::backup::backup_directory(&state)?
            .to_string_lossy()
            .into_owned(),
        export_directory: crate::export_path::directory(&state)?.to_string_lossy().into_owned(),
        database_size,
        journal_mode,
        schema_version,
        unlocked: state.is_unlocked()?,
    })
}

#[tauri::command]
pub fn open_data_directory(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let database = state.db_path()?;
    let path = crate::storage::data_directory(&database)?;
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn open_backup_directory(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let path = crate::backup::backup_directory(&state)?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn open_export_directory(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<(), String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权打开导出目录".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    let path = crate::export_path::create_directory(&state)?;
    Command::new("explorer.exe").arg(path).spawn().map_err(|error| error.to_string())?;
    Ok(())
}
