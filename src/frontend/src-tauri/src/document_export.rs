use crate::vault::VaultState;
use base64::Engine;
use chrono::Local;
use std::fs;

#[tauri::command(async, rename_all = "camelCase")]
pub fn export_document(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, name: String, extension: String, content: String) -> Result<String, String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("此窗口无权导出文档".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    if !["md", "json", "svg", "html", "png"].contains(&extension.as_str()) || content.len() > 64 * 1024 * 1024 { return Err("导出类型或文件大小无效".into()); }
    let safe_name: String = name.chars().map(|char| if char.is_control() || "<>:\"/\\|?*".contains(char) { '_' } else { char }).take(80).collect();
    let safe_name = safe_name.trim_matches([' ', '.']);
    let directory = crate::export_path::create_directory(&state)?;
    let file = directory.join(format!("{}-{}.{}", if safe_name.is_empty() { "文档" } else { safe_name }, Local::now().format("%Y%m%d-%H%M%S-%f"), extension));
    let bytes = if extension == "png" { let data = content.strip_prefix("data:image/png;base64,").ok_or("PNG 数据无效")?; let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "PNG 数据无效")?; if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("PNG 文件签名无效".into()); } bytes } else { content.into_bytes() };
    fs::write(&file, bytes).map_err(|_| "导出文件写入失败")?; Ok(file.to_string_lossy().into_owned())
}
