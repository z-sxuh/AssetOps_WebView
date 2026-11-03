use crate::vault::VaultState;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;
use tauri::Manager;

fn calendar_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "请输入有效的 HTTP/HTTPS 日历 URL")?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("日历 URL 只支持不含账号密码的 HTTP/HTTPS 地址".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn fetch_calendar(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, url: String) -> Result<String, String> {
    if window.label() != "main" || !state.is_unlocked()? { return Err("请在主窗口解锁后导入日历".into()); }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|_| "无法创建日历请求")?;
    let mut response = client.get(calendar_url(&url)?).send().await.map_err(|_| "无法读取日历 URL，请检查地址与网络")?.error_for_status().map_err(|_| "日历 URL 返回错误状态")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "日历下载失败")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("日历文件不能超过 2 MB".into()); }
        bytes.extend_from_slice(&chunk);
    }
    if !state.is_unlocked()? { return Err("数据仓库已锁定，请重新导入".into()); }
    String::from_utf8(bytes).map_err(|_| "日历必须为 UTF-8 JSON".into())
}

#[tauri::command(async)]
pub fn show_reminder(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, title: String, body: String) -> Result<(), String> {
    let _command = state.wait_for_command()?;
    if window.label() != "main" { return Err("请在主窗口使用提醒事项".into()); }
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    if title.trim().is_empty() || title.chars().count() > 128 || body.chars().count() > 2200 { return Err("提醒内容无效".into()); }
    #[cfg(target_os = "windows")]
    {
        // 当前通知插件会丢弃桌面点击事件，直接使用同一 WinRT 通知库注册回调。
        let app = window.app_handle().clone();
        tauri_winrt_notification::Toast::new(&app.config().identifier)
            .title(&title)
            .text1(&body)
            .sound(None)
            .on_activated(move |_| {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::search_hotkey::close_search(&handle);
                    let _ = crate::search_hotkey::show_main(&handle);
                });
                Ok(())
            })
            .show()
            .map_err(|_| "系统通知不可用，请在应用内查看提醒事项".into())
    }
    #[cfg(not(target_os = "windows"))]
    window.app_handle().notification().builder().title(title).body(body).show().map_err(|_| "系统通知不可用，请在应用内查看提醒事项".into())
}

#[cfg(test)]
mod tests {
    use super::calendar_url;
    #[test]
    fn accepts_calendar_http_urls() {
        assert!(calendar_url("https://unpkg.com/holiday-calendar@1.3.3/data/CN/2026.json").is_ok());
        assert!(calendar_url("http://localhost/calendar.json").is_ok());
    }
    #[test]
    fn rejects_non_http_calendar_urls_and_credentials() {
        for url in ["file:///C:/data.json", "javascript:alert(1)", "https://user:password@example.com/data", "invalid"] { assert!(calendar_url(url).is_err()); }
    }
}
