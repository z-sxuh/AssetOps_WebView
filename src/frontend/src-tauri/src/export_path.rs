use crate::vault::{self, VaultState};
use serde_json::Value;
use std::{fs, path::PathBuf};

pub fn resolve(configured: &str, downloads: Option<PathBuf>) -> Result<PathBuf, String> {
    let configured = configured.trim();
    let path = if configured.is_empty() { downloads.ok_or("无法定位当前用户下载目录，请在设置中指定导出目录")? } else { PathBuf::from(configured) };
    if !path.is_absolute() || path.to_string_lossy().contains('\0') { return Err("导出目录需要完整绝对路径".into()); }
    if path.is_file() { return Err("导出目录不能指向文件".into()); }
    Ok(path)
}
pub fn validate_setting(data: &Value) -> Result<(), String> {
    if let Some(value) = data.pointer("/settings/exportDirectory") {
        let path = value.as_str().ok_or("导出目录格式错误")?;
        if !path.trim().is_empty() { resolve(path, None)?; }
    }
    Ok(())
}
pub fn directory(state: &VaultState) -> Result<PathBuf, String> {
    let configured = if state.is_unlocked()? { vault::read_unlocked(state)?.pointer("/settings/exportDirectory").and_then(Value::as_str).unwrap_or("").to_owned() } else { String::new() };
    resolve(&configured, dirs::download_dir())
}
pub fn create_directory(state: &VaultState) -> Result<PathBuf, String> {
    let path = directory(state)?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建导出目录：{error}"))?;
    Ok(path)
}
#[tauri::command(async)]
pub fn validate_export_directory(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, directory: String) -> Result<(), String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权更改导出目录".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    let path = resolve(&directory, dirs::download_dir())?;
    fs::create_dir_all(path).map_err(|error| format!("无法创建导出目录：{error}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_and_custom_paths_use_the_same_policy() {
        let root = std::env::temp_dir().join(format!("assetops-export-path-{}", std::process::id()));
        assert_eq!(resolve("", Some(root.clone())).unwrap(), root);
        assert_eq!(resolve(root.to_str().unwrap(), None).unwrap(), root);
        assert!(resolve("relative", Some(root)).is_err());
        assert!(resolve("", None).is_err());
        assert!(validate_setting(&serde_json::json!({"settings":{"exportDirectory":42}})).is_err());
    }
}
