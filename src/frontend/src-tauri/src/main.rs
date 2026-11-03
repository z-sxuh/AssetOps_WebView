#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod app_info;
mod autostart;
mod backup;
mod excel;
mod search_hotkey;
mod storage;
mod vault;
mod document_export;
mod export_path;
mod calendar;
mod history_archive;
mod authorization;
#[cfg(target_os = "windows")]
mod install_shutdown;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use vault::VaultState;

#[derive(Default)]
struct RuntimeState {
    close_to_tray: AtomicBool,
    exit_guard: AtomicBool,
}

fn request_exit(app: &tauri::AppHandle) {
    if app.state::<RuntimeState>().exit_guard.load(Ordering::Relaxed) {
        let _ = search_hotkey::show_main(app);
        let _ = app.emit_to("main", "assetops-exit-request", ());
    } else {
        app.exit(0);
    }
}

#[tauri::command]
fn set_exit_guard(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可设置退出保护".to_owned()); }
    window.state::<RuntimeState>().exit_guard.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn confirm_exit(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可确认退出".to_owned()); }
    window.app_handle().exit(0);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn set_close_behavior(
    close_behavior: String,
    state: tauri::State<'_, RuntimeState>,
) -> Result<(), String> {
    match close_behavior.as_str() {
        "tray" => state.close_to_tray.store(true, Ordering::Relaxed),
        "exit" => state.close_to_tray.store(false, Ordering::Relaxed),
        _ => return Err("关闭按钮行为无效".to_owned()),
    }
    Ok(())
}

#[tauri::command]
fn set_window_appearance(window: tauri::WebviewWindow, dark: bool, icon_theme: Option<String>) -> Result<(), String> {
    let icon = match icon_theme.as_deref() {
        Some("dark") => tauri::include_image!("icons/server_asset/server_asset_app_dark_64.png"),
        Some("spring") => tauri::include_image!("icons/server_asset/server_asset_app_spring_64.png"),
        _ => tauri::include_image!("icons/server_asset/server_asset_app_light_64.png"),
    };
    for app_window in window.app_handle().webview_windows().values() {
        app_window.set_icon(icon.clone()).map_err(|error| error.to_string())?;
    }
    if let Some(tray) = window.app_handle().tray_by_id("assetops") {
        tray.set_icon(Some(icon)).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as _;
        let dark_mode: i32 = dark.into();
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                std::ptr::from_ref(&dark_mode).cast(),
                std::mem::size_of_val(&dark_mode) as u32,
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, dark);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(search_hotkey::handle_shortcut)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            search_hotkey::close_search(app);
            let _ = search_hotkey::show_main(app);
        }))
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                set_window_appearance(window, false, None).map_err(std::io::Error::other)?;
            }
            let executable = std::env::current_exe()?;
            let install_dir = executable
                .parent()
                .ok_or_else(|| std::io::Error::other("Cannot resolve executable directory"))?;
            let data_dir =
                storage::resolve_data_directory(install_dir).map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = storage::database_path(&data_dir).map_err(std::io::Error::other)?;
            vault::initialize(&db_path).map_err(std::io::Error::other)?;
            app.manage(VaultState::new(db_path));
            app.manage(
                search_hotkey::initialize(app.handle(), install_dir)
                    .map_err(std::io::Error::other)?,
            );

            let show_item =
                MenuItem::with_id(app, "show", "打开", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let search_item = MenuItem::with_id(app, "search", "搜索", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &search_item, &quit_item])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| std::io::Error::other("Application icon is unavailable"))?;
            TrayIconBuilder::with_id("assetops")
                .icon(icon)
                .tooltip("工作台")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        search_hotkey::close_search(app);
                        let _ = search_hotkey::show_main(app);
                    }
                    "search" => {
                        let _ = search_hotkey::open_search(app, true);
                    }
                    "restart" => {
                        match app.state::<VaultState>().prepare_restart() {
                            Ok(()) => { search_hotkey::close_search(app); app.request_restart(); }
                            Err(error) => {
                                let _ = search_hotkey::show_main(app);
                                let _ = app.emit_to("main", "assetops-operation-error", error);
                            }
                        }
                    }
                    "quit" => request_exit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        search_hotkey::close_search(tray.app_handle());
                        let _ = search_hotkey::show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            #[cfg(target_os = "windows")]
            for window in app.webview_windows().values() {
                install_shutdown::attach(window).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "search" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        search_hotkey::close_search(window.app_handle());
                    }
                    WindowEvent::Focused(false) if window.is_visible().unwrap_or(false) => {
                        search_hotkey::close_search(window.app_handle());
                    }
                    _ => {}
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<RuntimeState>();
                api.prevent_close();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    let _ = window.hide();
                } else {
                    request_exit(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_exit_guard,
            confirm_exit,
            vault::vault_exists,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_save,
            vault::vault_lock,
            vault::vault_change_password,
            vault::vault_reinitialize,
            document_export::export_document,
            calendar::fetch_calendar,
            calendar::show_reminder,
            set_close_behavior,
            set_window_appearance,
            search_hotkey::set_search_hotkey,
            search_hotkey::search_hotkey_status,
            search_hotkey::show_main_window,
            search_hotkey::show_search_window,
            search_hotkey::resize_search_window,
            search_hotkey::close_search_window,
            app_info::app_info,
            autostart::autostart_enabled,
            autostart::set_autostart,
            app_info::open_data_directory,
            app_info::open_backup_directory,
            app_info::open_export_directory,
            export_path::validate_export_directory,
            backup::backup_create,
            backup::backup_list,
            backup::backup_restore,
            backup::backup_delete,
            backup::backup_simulate_cleanup,
            backup::backup_copy_to_directory,
            excel::export_assets,
            excel::export_template,
            excel::export_audit,
            history_archive::export_history_archive,
            history_archive::read_history_archive,
            history_archive::compact_history_database,
            excel::export_import_report,
            excel::reveal_in_folder,
            excel::parse_import_xlsx
        ])
        .run(tauri::generate_context!())
        .expect("工作台启动失败");
}
