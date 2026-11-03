use crate::{storage, vault::VaultState};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcut, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

pub struct SearchHotkeyState {
    install_directory: PathBuf,
    binding: Mutex<Binding>,
    window_requested: AtomicBool,
    request: AtomicU64,
}

struct Binding {
    hotkey: String,
    shortcut: Option<Shortcut>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHotkeyStatus {
    hotkey: String,
    registered: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    from_background: bool,
    detached: bool,
    request: u64,
}

trait ShortcutRegistry {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

impl<R: Runtime> ShortcutRegistry for GlobalShortcut<R> {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        GlobalShortcut::register(self, shortcut)
            .map_err(|error| format!("全局搜索快捷键注册失败，可能已被其他应用占用：{error}"))
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        GlobalShortcut::unregister(self, shortcut).map_err(|error| error.to_string())
    }
}

fn parse_shortcut(hotkey: &str) -> Result<Option<Shortcut>, String> {
    if hotkey.trim().is_empty() {
        return Ok(None);
    }
    let normalized = hotkey
        .split('+')
        .map(|part| {
            let part = part.trim();
            if part.eq_ignore_ascii_case("win") || part.eq_ignore_ascii_case("meta") {
                "Super"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("+");
    let shortcut: Shortcut = normalized
        .parse()
        .map_err(|error| format!("搜索快捷键无效：{error}"))?;
    if !shortcut
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
        && !matches!(shortcut.key, Code::F1 | Code::F2 | Code::F3 | Code::F4 | Code::F5 | Code::F6 | Code::F7 | Code::F8 | Code::F9 | Code::F10 | Code::F11 | Code::F12 | Code::F13 | Code::F14 | Code::F15 | Code::F16 | Code::F17 | Code::F18 | Code::F19 | Code::F20 | Code::F21 | Code::F22 | Code::F23 | Code::F24)
    {
        return Err("搜索快捷键支持 F1–F24，其他按键必须包含 Ctrl、Alt 或 Win".to_owned());
    }
    Ok(Some(shortcut))
}

fn replace_binding(
    binding: &mut Binding,
    hotkey: &str,
    registry: &impl ShortcutRegistry,
    persist: impl Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    let hotkey = hotkey.trim();
    let next = parse_shortcut(hotkey)?;
    let changed = next != binding.shortcut;
    if changed {
        if let Some(shortcut) = next {
            registry.register(shortcut)?;
        }
    }
    if let Err(error) = persist(hotkey) {
        if changed {
            if let Some(shortcut) = next {
                registry
                    .unregister(shortcut)
                    .map_err(|cleanup| format!("{error}；撤销新快捷键失败：{cleanup}"))?;
            }
        }
        return Err(error);
    }
    if changed {
        if let Some(shortcut) = binding.shortcut {
            if let Err(error) = registry.unregister(shortcut) {
                let restored = persist(&binding.hotkey);
                let removed = next
                    .map(|candidate| registry.unregister(candidate))
                    .transpose();
                return Err(format!(
                    "更换搜索快捷键失败：{error}{}{}",
                    restored
                        .err()
                        .map(|reason| format!("；恢复配置失败：{reason}"))
                        .unwrap_or_default(),
                    removed
                        .err()
                        .map(|reason| format!("；撤销新快捷键失败：{reason}"))
                        .unwrap_or_default()
                ));
            }
        }
    }
    binding.hotkey = hotkey.to_owned();
    binding.shortcut = next;
    binding.error = None;
    Ok(())
}

pub fn initialize(app: &AppHandle, install_directory: &Path) -> Result<SearchHotkeyState, String> {
    let hotkey = storage::read_search_hotkey(install_directory)?;
    let mut binding = Binding {
        hotkey,
        shortcut: None,
        error: None,
    };
    match parse_shortcut(&binding.hotkey).and_then(|shortcut| {
        if let Some(shortcut) = shortcut {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())?;
        }
        Ok(shortcut)
    }) {
        Ok(shortcut) => binding.shortcut = shortcut,
        Err(error) => {
            binding.error = Some(format!(
                "全局搜索快捷键未启用，请在设置中更换组合键：{error}"
            ))
        }
    }
    Ok(SearchHotkeyState {
        install_directory: install_directory.to_owned(),
        binding: Mutex::new(binding),
        window_requested: AtomicBool::new(false),
        request: AtomicU64::new(0),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_search_hotkey(
    app: AppHandle,
    state: tauri::State<'_, SearchHotkeyState>,
    hotkey: String,
) -> Result<(), String> {
    let mut binding = state.binding.lock().map_err(|_| "搜索快捷键状态不可用")?;
    replace_binding(&mut binding, &hotkey, app.global_shortcut(), |value| {
        storage::save_search_hotkey(&state.install_directory, value)
    })
}

#[tauri::command]
pub fn search_hotkey_status(
    state: tauri::State<'_, SearchHotkeyState>,
) -> Result<SearchHotkeyStatus, String> {
    let binding = state.binding.lock().map_err(|_| "搜索快捷键状态不可用")?;
    Ok(SearchHotkeyStatus {
        hotkey: binding.hotkey.clone(),
        registered: binding.shortcut.is_some(),
        error: binding.error.clone(),
    })
}

pub fn open_search(app: &AppHandle, force: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("无法找到主窗口")?;
    let from_background = force || !window.is_focused().unwrap_or(false);
    let detached = use_search_window(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
    );
    let request = app.state::<SearchHotkeyState>().request.fetch_add(1, Ordering::Relaxed) + 1;
    app.state::<SearchHotkeyState>()
        .window_requested
        .store(detached, Ordering::Relaxed);
    if !detached || !app.state::<VaultState>().is_unlocked()? {
        show_main(app)?;
    }
    app.emit_to(
        "main",
        "assetops-open-search",
        SearchRequest {
            from_background,
            detached,
            request,
        },
    )
    .map_err(|error| error.to_string())
}

fn use_search_window(visible: bool, minimized: bool) -> bool {
    !visible || minimized
}

pub fn show_main(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("无法找到主窗口")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    show_main(&app)
}

#[tauri::command]
pub fn show_search_window(app: AppHandle, height: u32) -> Result<(), String> {
    if !app
        .state::<SearchHotkeyState>()
        .window_requested
        .load(Ordering::Relaxed)
        || !app.state::<VaultState>().is_unlocked()?
    {
        return Ok(());
    }
    let window = app.get_webview_window("search").ok_or("无法找到搜索小窗")?;
    resize_search_window(app.clone(), height)?;
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let area = monitor.work_area();
        window
            .set_position(search_position(
                area.position,
                area.size,
                monitor.scale_factor(),
            ))
            .map_err(|error| error.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn search_position(
    origin: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) -> tauri::PhysicalPosition<i32> {
    // 为展开后的结果预留空间，输入时只增高，不移动搜索框。
    tauri::PhysicalPosition::new(
        origin.x + ((size.width as f64 - 680.0 * scale).max(0.0) / 2.0).round() as i32,
        origin.y + ((size.height as f64 - 540.0 * scale).max(0.0) / 2.0).round() as i32,
    )
}

#[tauri::command]
pub fn resize_search_window(app: AppHandle, height: u32) -> Result<(), String> {
    if !app
        .state::<SearchHotkeyState>()
        .window_requested
        .load(Ordering::Relaxed)
        || !app.state::<VaultState>().is_unlocked()?
    {
        return Ok(());
    }
    app.get_webview_window("search")
        .ok_or("无法找到搜索小窗")?
        .set_size(tauri::LogicalSize::new(680.0, height.clamp(72, 540) as f64))
        .map_err(|error| error.to_string())
}

pub fn close_search(app: &AppHandle) {
    let request = if let Some(state) = app.try_state::<SearchHotkeyState>() {
        state.window_requested.store(false, Ordering::Relaxed);
        Some(state.request.load(Ordering::Relaxed))
    } else { None };
    if let Some(window) = app.get_webview_window("search") {
        let _ = window.hide();
    }
    let _ = app.emit_to("search", "assetops-search-clear", request);
    let _ = app.emit_to("main", "assetops-search-closed", ());
}

#[tauri::command]
pub fn close_search_window(app: AppHandle) {
    close_search(&app);
}

fn should_open(active: Option<Shortcut>, shortcut: Shortcut, event: ShortcutState) -> bool {
    event == ShortcutState::Pressed && active == Some(shortcut)
}

pub fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if let Some(state) = app.try_state::<SearchHotkeyState>() {
        // 注册切换会等待主线程；回调不阻塞它，也不响应事务中尚未生效的新键。
        let open = state
            .binding
            .try_lock()
            .map(|binding| should_open(binding.shortcut, *shortcut, event.state))
            .unwrap_or(false);
        if open {
            let _ = open_search(app, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistry {
        registered: RefCell<Vec<Shortcut>>,
        actions: RefCell<Vec<String>>,
        unavailable: Option<Shortcut>,
        fail_unregister: Option<Shortcut>,
    }

    impl ShortcutRegistry for FakeRegistry {
        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            self.actions
                .borrow_mut()
                .push(format!("register:{}", shortcut.id()));
            if self.unavailable == Some(shortcut) {
                return Err("快捷键已占用".to_owned());
            }
            let mut registered = self.registered.borrow_mut();
            if registered.contains(&shortcut) {
                return Err("重复注册".to_owned());
            }
            registered.push(shortcut);
            Ok(())
        }
        fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
            self.actions
                .borrow_mut()
                .push(format!("unregister:{}", shortcut.id()));
            if self.fail_unregister == Some(shortcut) {
                return Err("注销失败".to_owned());
            }
            self.registered
                .borrow_mut()
                .retain(|entry| *entry != shortcut);
            Ok(())
        }
    }

    fn initial() -> (Binding, FakeRegistry) {
        let shortcut = parse_shortcut("Ctrl+Shift+K").unwrap().unwrap();
        (
            Binding {
                hotkey: "Ctrl+Shift+K".to_owned(),
                shortcut: Some(shortcut),
                error: None,
            },
            FakeRegistry {
                registered: RefCell::new(vec![shortcut]),
                ..Default::default()
            },
        )
    }

    #[test]
    fn parses_windows_modifiers_and_rejects_invalid_shortcuts() {
        assert_eq!(
            parse_shortcut(" Ctrl + Win + K ").unwrap(),
            parse_shortcut("Control+Super+K").unwrap()
        );
        assert!(parse_shortcut(" ").unwrap().is_none());
        assert!(parse_shortcut("Shift+K").is_err());
        assert!(parse_shortcut("K").is_err());
        assert!(parse_shortcut("F25").is_err());
        for key in ["F1", "F4", "F24", "Shift+F4"] { assert!(parse_shortcut(key).unwrap().is_some()); }
        assert!(parse_shortcut("Ctrl+K+L").is_err());
        assert!(parse_shortcut("Ctrl++K").is_err());
    }

    #[test]
    fn replacement_registers_first_and_is_idempotent() {
        let (mut binding, registry) = initial();
        let persisted = RefCell::new(Vec::new());
        replace_binding(&mut binding, "Ctrl+Alt+S", &registry, |value| {
            persisted.borrow_mut().push(value.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(binding.hotkey, "Ctrl+Alt+S");
        assert!(registry.actions.borrow()[0].starts_with("register:"));
        assert!(registry.actions.borrow()[1].starts_with("unregister:"));
        replace_binding(&mut binding, "Control+Alt+S", &registry, |_| Ok(())).unwrap();
        assert_eq!(registry.actions.borrow().len(), 2);
        assert_eq!(registry.registered.borrow().len(), 1);
    }

    #[test]
    fn occupied_shortcut_keeps_old_registration_and_config() {
        let (mut binding, mut registry) = initial();
        registry.unavailable = parse_shortcut("Ctrl+Alt+S").unwrap();
        let persisted = RefCell::new(Vec::new());
        assert!(
            replace_binding(&mut binding, "Ctrl+Alt+S", &registry, |value| {
                persisted.borrow_mut().push(value.to_owned());
                Ok(())
            })
            .is_err()
        );
        assert_eq!(binding.hotkey, "Ctrl+Shift+K");
        assert_eq!(
            *registry.registered.borrow(),
            vec![binding.shortcut.unwrap()]
        );
        assert!(persisted.borrow().is_empty());
    }

    #[test]
    fn failed_persistence_removes_new_shortcut_and_keeps_old() {
        let (mut binding, registry) = initial();
        assert!(
            replace_binding(&mut binding, "Ctrl+Alt+S", &registry, |_| Err(
                "写配置失败".to_owned()
            ))
            .is_err()
        );
        assert_eq!(binding.hotkey, "Ctrl+Shift+K");
        assert_eq!(
            *registry.registered.borrow(),
            vec![binding.shortcut.unwrap()]
        );
    }

    #[test]
    fn failed_unregister_restores_configuration_and_keeps_old() {
        let (mut binding, mut registry) = initial();
        registry.fail_unregister = binding.shortcut;
        let persisted = RefCell::new(Vec::new());
        assert!(
            replace_binding(&mut binding, "Ctrl+Alt+S", &registry, |value| {
                persisted.borrow_mut().push(value.to_owned());
                Ok(())
            })
            .is_err()
        );
        assert_eq!(*persisted.borrow(), vec!["Ctrl+Alt+S", "Ctrl+Shift+K"]);
        assert_eq!(
            *registry.registered.borrow(),
            vec![binding.shortcut.unwrap()]
        );
    }

    #[test]
    fn clearing_shortcut_disables_and_can_be_repeated() {
        let (mut binding, registry) = initial();
        replace_binding(&mut binding, "", &registry, |_| Ok(())).unwrap();
        assert!(binding.shortcut.is_none());
        assert_eq!(binding.hotkey, "");
        assert!(registry.registered.borrow().is_empty());
        replace_binding(&mut binding, "", &registry, |_| Ok(())).unwrap();
        assert_eq!(registry.actions.borrow().len(), 1);
    }

    #[test]
    fn only_active_pressed_event_opens_search() {
        let active = parse_shortcut("Ctrl+Shift+K").unwrap().unwrap();
        let other = parse_shortcut("Ctrl+Alt+S").unwrap().unwrap();
        assert!(should_open(Some(active), active, ShortcutState::Pressed));
        assert!(!should_open(Some(active), active, ShortcutState::Released));
        assert!(!should_open(Some(active), other, ShortcutState::Pressed));
        assert!(!should_open(None, active, ShortcutState::Pressed));
    }

    #[test]
    fn hidden_or_minimized_search_leaves_main_closed() {
        assert!(use_search_window(false, false));
        assert!(use_search_window(true, true));
        assert!(!use_search_window(true, false));
    }

    #[test]
    fn physical_shift_keys_are_supported() {
        for key in [
            "1",
            "Slash",
            "Equal",
            "Minus",
            "Backquote",
            "ArrowUp",
            "F12",
        ] {
            assert!(parse_shortcut(&format!("Ctrl+Shift+{key}"))
                .unwrap()
                .is_some());
        }
    }

    #[test]
    fn expanding_search_keeps_space_on_scaled_and_secondary_monitors() {
        for (origin, size, scale) in [
            ((0, 0), (1920, 1040), 1.0),
            ((-3840, -200), (3840, 2080), 2.0),
            ((1920, 0), (2560, 1400), 1.5),
        ] {
            let position = search_position(
                tauri::PhysicalPosition::new(origin.0, origin.1),
                tauri::PhysicalSize::new(size.0, size.1),
                scale,
            );
            assert!(position.x >= origin.0 && position.y >= origin.1);
            assert!(position.x as f64 + 680.0 * scale <= origin.0 as f64 + size.0 as f64);
            assert!(position.y as f64 + 540.0 * scale <= origin.1 as f64 + size.1 as f64);
        }
    }
}
