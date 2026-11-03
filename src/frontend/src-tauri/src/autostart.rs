use crate::vault::VaultState;
use tauri::Manager;

#[tauri::command(async)]
pub fn autostart_enabled(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>) -> Result<bool, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.wait_for_operation()?;
    access(&window, &state)?;
    current(&window, None)
}

#[tauri::command(async)]
pub fn set_autostart(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, enabled: bool) -> Result<bool, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.wait_for_operation()?;
    access(&window, &state)?;
    current(&window, Some(enabled))
}

fn access(window: &tauri::WebviewWindow, state: &VaultState) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    Ok(())
}

fn current(window: &tauri::WebviewWindow, enabled: Option<bool>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        windows::configure(windows::RUN_KEY, &window.app_handle().config().identifier, &executable, enabled)
    }
    #[cfg(not(windows))]
    { let _ = (window, enabled); Err("开机自启动仅支持 Windows 桌面应用".into()) }
}

#[cfg(windows)]
mod windows {
    use std::{os::windows::ffi::OsStrExt, path::Path, ptr};
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS}, System::Registry::*};

    pub(super) const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    struct Key(HKEY);
    impl Drop for Key { fn drop(&mut self) { unsafe { RegCloseKey(self.0); } } }
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn error(code: u32) -> String { format!("无法访问开机自启动设置：{}", std::io::Error::from_raw_os_error(code as i32)) }
    fn command(executable: &Path) -> Vec<u16> {
        [b'"' as u16].into_iter().chain(executable.as_os_str().encode_wide()).chain([b'"' as u16, 0]).collect()
    }
    pub(super) fn configure(subkey: &str, name: &str, executable: &Path, enabled: Option<bool>) -> Result<bool, String> {
        let subkey = wide(subkey); let name = wide(name); let expected = command(executable);
        if enabled == Some(true) && expected.len() - 1 > 260 { return Err("应用路径过长，无法设置开机自启动".into()); }
        let mut raw = ptr::null_mut();
        let code = unsafe {
            if enabled == Some(true) {
                RegCreateKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, ptr::null(), REG_OPTION_NON_VOLATILE, KEY_QUERY_VALUE | KEY_SET_VALUE, ptr::null(), &mut raw, ptr::null_mut())
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_QUERY_VALUE | if enabled.is_some() { KEY_SET_VALUE } else { 0 }, &mut raw)
            }
        };
        if code == ERROR_FILE_NOT_FOUND { return Ok(false); }
        if code != ERROR_SUCCESS { return Err(error(code)); }
        let key = Key(raw);
        if let Some(enabled) = enabled {
            let code = unsafe {
                if enabled { RegSetValueExW(key.0, name.as_ptr(), 0, REG_SZ, expected.as_ptr().cast(), (expected.len() * 2) as u32) }
                else { RegDeleteValueW(key.0, name.as_ptr()) }
            };
            if code != ERROR_SUCCESS && !(code == ERROR_FILE_NOT_FOUND && !enabled) { return Err(error(code)); }
        }
        let mut size = 0;
        let code = unsafe { RegGetValueW(key.0, ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, ptr::null_mut(), ptr::null_mut(), &mut size) };
        if code == ERROR_FILE_NOT_FOUND { return Ok(false); }
        if code != ERROR_SUCCESS { return Err(error(code)); }
        let mut value = vec![0_u16; (size as usize).div_ceil(2)];
        let code = unsafe { RegGetValueW(key.0, ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, ptr::null_mut(), value.as_mut_ptr().cast(), &mut size) };
        if code != ERROR_SUCCESS { return Err(error(code)); }
        value.truncate(size as usize / 2);
        let actual = value == expected;
        if enabled.is_some_and(|enabled| enabled != actual) { return Err("开机自启动设置未生效，请重试".into()); }
        Ok(actual)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn quotes_unicode_paths_and_rejects_oversized_run_commands() {
            assert_eq!(command(Path::new(r"C:\测试应用\My App\assetops.exe")), wide(r#""C:\测试应用\My App\assetops.exe""#));
            let long = format!("C:\\{}\\assetops.exe", "a".repeat(260));
            assert!(configure(r"Software\AssetOps\Tests\LongCommand", "test", Path::new(&long), Some(true)).is_err());
            assert!(!configure(r"Software\AssetOps\Tests\LongCommand", "test", Path::new(&long), Some(false)).unwrap());
        }
        #[test]
        fn isolated_registry_value_roundtrip_preserves_other_entries() {
            // 使用普通测试键，绝不注册实际登录启动项。
            let subkey = format!(r"Software\AssetOps\Tests\Autostart-{}", std::process::id());
            let exe = Path::new(r"C:\测试应用\My App\assetops.exe");
            let other = Path::new(r"C:\Other\other.exe");
            let result = std::panic::catch_unwind(|| {
                assert!(!configure(&subkey, "test-app", exe, None).unwrap());
                assert!(configure(&subkey, "other-app", other, Some(true)).unwrap());
                assert!(configure(&subkey, "test-app", exe, Some(true)).unwrap());
                assert!(configure(&subkey, "test-app", exe, None).unwrap());
                assert!(!configure(&subkey, "test-app", other, None).unwrap());
                assert!(!configure(&subkey, "test-app", exe, Some(false)).unwrap());
                assert!(!configure(&subkey, "test-app", exe, Some(false)).unwrap());
                assert!(configure(&subkey, "other-app", other, None).unwrap());
            });
            unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(&subkey).as_ptr()); }
            result.unwrap();
        }
    }
}
