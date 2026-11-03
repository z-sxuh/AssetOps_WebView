use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION},
    },
};

// 安装器的关闭通知必须结束应用，不能走普通关闭按钮的“隐藏到托盘”流程。
pub fn attach(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    let handle = Box::into_raw(Box::new(window.app_handle().clone()));
    if unsafe { SetWindowSubclass(hwnd, Some(shutdown_callback), 1, handle as usize) } == 0 {
        unsafe { drop(Box::from_raw(handle)); }
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

unsafe extern "system" fn shutdown_callback(
    hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, data: usize,
) -> LRESULT {
    if message == WM_QUERYENDSESSION && lparam & 1 != 0 { return 1; }
    if is_install_shutdown(message, wparam, lparam) {
        (*(data as *const tauri::AppHandle)).exit(0);
        return 0;
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(shutdown_callback), id);
        drop(Box::from_raw(data as *mut tauri::AppHandle));
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn is_install_shutdown(message: u32, wparam: WPARAM, lparam: LPARAM) -> bool {
    message == WM_ENDSESSION && wparam != 0 && lparam & 1 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_confirmed_installer_shutdown_exits() {
        assert!(is_install_shutdown(WM_ENDSESSION, 1, 1));
        assert!(is_install_shutdown(WM_ENDSESSION, 1, 0x40000001));
        assert!(!is_install_shutdown(WM_QUERYENDSESSION, 1, 1));
        assert!(!is_install_shutdown(WM_ENDSESSION, 0, 1));
        assert!(!is_install_shutdown(WM_ENDSESSION, 1, 0));
    }
}
