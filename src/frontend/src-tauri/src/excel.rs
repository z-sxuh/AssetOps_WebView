use crate::vault::{self, VaultState};
use calamine::{Data, Reader, Xlsx};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use rust_xlsxwriter::{utility::cell_autofit_width, Color, DataValidation, Format, FormatAlign, FormatBorder, ProtectionOptions, Workbook, Worksheet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    net::IpAddr,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    path: String,
    file_name: String,
    rows: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    sheet: String,
    row_number: usize,
    column: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParseResult {
    rows: Vec<Value>,
    errors: Vec<ImportError>,
    metadata: Value,
    unmapped_headers: Vec<String>,
    headers: Vec<String>,
    sheet_headers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReportRow {
    sheet: String,
    line: usize,
    status: String,
    host: String,
    message: String,
}

fn export_directory(state: &VaultState) -> Result<PathBuf, String> {
    crate::export_path::create_directory(state)
}

fn unique_export_path(directory: &Path, prefix: &str) -> PathBuf {
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut path = directory.join(format!("{prefix}-{timestamp}.xlsx"));
    let mut suffix = 1_u16;
    while path.exists() {
        path = directory.join(format!("{prefix}-{timestamp}-{suffix}.xlsx"));
        suffix += 1;
    }
    path
}

fn csv_cell(value: &str) -> String {
    let safe = if value.starts_with(['\t', '\r']) || value
        .trim_start()
        .chars()
        .next()
        .is_some_and(|character| matches!(character, '=' | '+' | '-' | '@'))
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn export_import_report(window: tauri::WebviewWindow,
    rows: Vec<ImportReportRow>,
    state: tauri::State<'_, VaultState>,
) -> Result<ExportFile, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    vault::read_unlocked(&state)?;
    let mut path =
        unique_export_path(&export_directory(&state)?, "导入预检报告").with_extension("csv");
    let base = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("导入预检报告")
        .to_owned();
    let mut suffix = 2_u16;
    while path.exists() {
        path.set_file_name(format!("{base}-{suffix}.csv"));
        suffix += 1;
    }
    let mut content = String::from("\u{feff}工作表,行号,状态,主机名,说明\r\n");
    for row in &rows {
        content.push_str(&format!(
            "{},{},{},{},{}\r\n",
            csv_cell(&row.sheet),
            row.line,
            csv_cell(&row.status),
            csv_cell(&row.host),
            csv_cell(&row.message)
        ));
    }
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(ExportFile {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
        path: path.to_string_lossy().into_owned(),
        rows: rows.len(),
    })
}

fn asset_value<'a>(asset: &'a Value, key: &str) -> Option<&'a Value> {
    asset
        .get(key)
        .or_else(|| asset.get("values").and_then(|values| values.get(key)))
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => String::new(),
    }
}

fn audit_value(item: &Value, key: &str, include_sensitive: bool) -> String {
    match item.get("fieldKey").and_then(Value::as_str) {
        Some("accounts" | "password" | "custom") if !include_sensitive => "[敏感字段已隐藏]".to_owned(),
        _ => string_value(item.get(key)),
    }
}

fn sheet_name(name: &str, used: &mut HashSet<String>) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if matches!(character, '[' | ']' | ':' | '*' | '?' | '/' | '\\') {
                '_'
            } else {
                character
            }
        })
        .collect();
    let base: String = cleaned.chars().take(31).collect();
    let base = base.trim().trim_matches('\'').trim();
    let base = if base.is_empty() {
        "资产"
    } else {
        base
    };
    let mut candidate = base.to_owned();
    let mut suffix = 2_u16;
    while used.contains(&candidate.to_lowercase()) {
        let marker = format!("-{suffix}");
        let keep = 31_usize.saturating_sub(marker.chars().count());
        candidate = format!("{}{}", base.chars().take(keep).collect::<String>(), marker);
        suffix += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

type SystemNames = HashMap<String, (String, String)>;
type EnvironmentNames = HashMap<String, String>;
type ZoneNames = HashMap<String, String>;
type SystemPaths = HashMap<String, Vec<String>>;

fn structure_names(data: &Value) -> (SystemNames, EnvironmentNames, ZoneNames, SystemPaths) {
    let mut systems = HashMap::new();
    let mut environments = HashMap::new();
    let mut zones = HashMap::new();
    let mut paths = HashMap::new();
    for unit in data
        .get("units")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let unit_name = string_value(unit.get("name"));
        for environment in unit
            .get("environments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            environments.insert(
                string_value(environment.get("id")),
                string_value(environment.get("name")),
            );
            let environment_name = string_value(environment.get("name"));
            for zone in environment
                .get("zones")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let zone_name = string_value(zone.get("name"));
                zones.insert(string_value(zone.get("id")), zone_name.clone());
                for system in zone
                    .get("systems")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let system_id = string_value(system.get("id"));
                    let system_name = string_value(system.get("name"));
                    systems.insert(system_id.clone(), (unit_name.clone(), system_name.clone()));
                    paths.insert(
                        system_id,
                        vec![unit_name.clone(), environment_name.clone(), zone_name.clone(), system_name],
                    );
                }
            }
        }
    }
    for system in data
        .get("systems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let system_id = string_value(system.get("id"));
        let unit_id = string_value(system.get("unitId"));
        let unit_name = data
            .get("units")
            .and_then(Value::as_array)
            .and_then(|units| {
                units
                    .iter()
                    .find(|unit| string_value(unit.get("id")) == unit_id)
            })
            .map(|unit| string_value(unit.get("name")))
            .unwrap_or_default();
        systems.insert(system_id, (unit_name, string_value(system.get("name"))));
    }
    for environment in data
        .get("environments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        environments.insert(
            string_value(environment.get("id")),
            string_value(environment.get("name")),
        );
    }
    (systems, environments, zones, paths)
}

fn joined_disks(asset: &Value) -> String {
    asset_value(asset, "disks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|disk| {
            let label = string_value(disk.get("label"));
            let capacity = disk.get("capacity").or_else(|| disk.get("capacityGb"));
            let unit = disk.get("unit").and_then(Value::as_str).unwrap_or("G");
            format!("{label}:{}{unit}", string_value(capacity))
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn joined_tags(asset: &Value) -> String {
    asset_value(asset, "tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

fn account_columns(asset: &Value, include_passwords: bool) -> (String, String, String) {
    let accounts = asset_value(asset, "accounts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let usernames = accounts
        .iter()
        .map(|account| string_value(account.get("username")))
        .collect::<Vec<_>>()
        .join(";");
    let passwords = if include_passwords {
        if accounts.len() == 1 {
            string_value(accounts[0].get("password"))
        } else {
            serde_json::to_string(
                &accounts
                    .iter()
                    .map(|account| string_value(account.get("password")))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        }
    } else {
        String::new()
    };
    let updated = accounts
        .iter()
        .map(|account| export_datetime(&string_value(account.get("passwordUpdatedAt"))))
        .collect::<Vec<_>>()
        .join(";");
    (usernames, passwords, updated)
}

fn export_datetime(value: &str) -> String {
    let format = "%Y-%m-%d %H:%M:%S";
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return date.with_timezone(&Local).format(format).to_string();
    }
    if let Ok(date) = NaiveDateTime::parse_from_str(value, format) {
        return date.format(format).to_string();
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).unwrap().format(format).to_string();
    }
    value.to_owned()
}

fn export_cell_width(value: &str) -> u32 {
    // The library uses 8px for non-ASCII glyphs; allow full Chinese glyphs in YaHei.
    value.lines().map(|line| {
        let width = cell_autofit_width(line) + line.chars().filter(|character| !character.is_ascii()).count() as u32 * 8;
        (width * 5 / 4 + 8).min(1790)
    }).max().unwrap_or(0)
}

fn write_export_cell(worksheet: &mut Worksheet, row: u32, column: u16, value: &str, format: &Format, widths: &mut [u32]) -> Result<(), String> {
    let wrapped = value.contains(['\n', '\r']).then(|| format.clone().set_text_wrap());
    worksheet.write_string_with_format(row, column, value, wrapped.as_ref().unwrap_or(format)).map_err(|error| error.to_string())?;
    widths[column as usize] = widths[column as usize].max(export_cell_width(value));
    Ok(())
}

fn fit_export_columns(worksheet: &mut Worksheet, widths: &[u32]) -> Result<(), String> {
    for (column, width) in widths.iter().enumerate() {
        worksheet.set_column_autofit_width(column as u16, *width).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn reveal_in_folder(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, path: String) -> Result<(), String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    if !state.is_unlocked()? { return Err("请先解锁数据仓库".into()); }
    let database = state.db_path()?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let roots = [crate::storage::data_directory(&database)?.to_path_buf(), crate::backup::backup_directory(&state)?, crate::export_path::directory(&state)?, executable.parent().ok_or("无法定位应用目录")?.join("history-archives")];
    reveal_target(&allowed_reveal_path(Path::new(&path), &roots)?)
}

fn allowed_reveal_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|_| "文件不存在，无法打开目录")?;
    if roots.iter().filter_map(|root| root.canonicalize().ok()).any(|root| path.starts_with(root)) { Ok(path) } else { Err("只能打开应用数据、备份或导出目录内的文件".into()) }
}

fn reveal_target(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn fields_for_system<'a>(data: &'a Value, system_id: &str) -> Vec<&'a Value> {
    let mut fields = data
        .get("fieldDefs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|field| string_value(field.get("systemId")) == system_id)
        .collect::<Vec<_>>();
    fields.sort_by_key(|field| {
        field
            .get("sortOrder")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    fields
}

fn field_fingerprint(data: &Value, system_id: &str) -> String {
    let fields = fields_for_system(data, system_id)
        .into_iter()
        .map(|field| {
            json!({
                "key": field.get("key"),
                "type": field.get("type"),
                "required": field.get("required"),
                "unique": field.get("unique"),
                "sortOrder": field.get("sortOrder")
            })
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&fields).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn custom_value(asset: &Value, key: &str) -> String {
    string_value(asset.get("custom").and_then(|custom| custom.get(key)))
}

fn field_key(key: &str) -> &str {
    match key {
        "businessSystem" => "business_system",
        "ip" => "ip_1",
        "ip2" => "ip_2",
        "memory" => "mem",
        "accounts" => "user",
        "passwords" => "password",
        "rotatePassword" => "pwd_rotate",
        "passwordCycleDays" => "pwd_cycle_days",
        "createdAt" => "created_at",
        "updatedAt" => "updated_at",
        _ => key,
    }
}

fn export_label(data: &Value, system_id: &str, key: &str) -> String {
    if let Some(field) = fields_for_system(data, system_id)
        .into_iter()
        .find(|field| field.get("key").and_then(Value::as_str) == Some(field_key(key)))
    {
        return string_value(field.get("label"));
    }
    match key {
        "businessSystem" => "业务系统",
        "name" => "服务器名称",
        "host" => "主机名",
        "ip" => "IP",
        "ip2" => "备用 IP",
        "status" => "状态",
        "cpu" => "CPU",
        "memory" => "内存",
        "os" => "操作系统",
        "disks" => "硬盘",
        "asset:tags" => "资产标签",
        "accounts" => "账号",
        "passwords" => "密码",
        "passwordUpdatedAt" => "密码修改日期",
        "rotatePassword" => "定期修改密码",
        "passwordCycleDays" => "密码更新周期",
        "createdAt" => "创建日期",
        "updatedAt" => "修改日期",
        "unit" => "单位",
        "environment" => "环境",
        "zone" => "网络区域",
        "system" => "系统",
        _ => key,
    }
    .to_owned()
}

fn import_field_key(key: &str) -> &str {
    match key {
        "business_system" => "businessSystem",
        "ip_1" => "ip",
        "ip_2" => "ip2",
        "mem" => "memory",
        "user" => "accounts",
        "password" => "passwords",
        "pwd_rotate" => "rotatePassword",
        "pwd_cycle_days" => "passwordCycleDays",
        "asset_tag" => "asset:tags",
        _ => key,
    }
}

fn template_workbook(_data: &Value, fields: &[Value]) -> Result<Workbook, String> {
    let mut fields = fields
        .iter()
        .filter(|field| {
            !matches!(
                string_value(field.get("key")).as_str(),
                "created_at" | "updated_at" | "createdAt" | "updatedAt" | "passwordUpdatedAt" | "pwd_expire_at"
            )
        })
        .collect::<Vec<_>>();
    fields.sort_by_key(|field| {
        field
            .get("sortOrder")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    if fields.is_empty() {
        return Err("所选模板没有可导入字段".to_owned());
    }
    let default_format = Format::new()
        .set_unlocked()
        .set_text_wrap()
        .set_align(FormatAlign::VerticalCenter);
    let mut workbook = Workbook::new();
    workbook
        .set_default_format(&default_format, 40, 64)
        .map_err(|error| error.to_string())?;
    workbook
        .add_worksheet()
        .set_name("资产导入")
        .map_err(|error| error.to_string())?;
    workbook
        .add_worksheet()
        .set_name("_lists")
        .map_err(|error| error.to_string())?
        .set_hidden(true);
    workbook
        .add_worksheet()
        .set_name("_columns")
        .map_err(|error| error.to_string())?
        .set_hidden(true);
    {
        let meta = workbook.add_worksheet();
        meta.set_name("_meta").map_err(|error| error.to_string())?;
        meta.write_string(0, 0, "noteRow").map_err(|error| error.to_string())?;
        meta.write_string(0, 1, "1").map_err(|error| error.to_string())?;
        meta.set_hidden(true);
    }
    let header_format = Format::new()
        .set_background_color(Color::RGB(0xE9F5EE))
        .set_border(FormatBorder::Thin)
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let note_format = Format::new()
        .set_background_color(Color::RGB(0xFDF6E4))
        .set_border(FormatBorder::Thin)
        .set_text_wrap()
        .set_font_size(10)
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let data_format = default_format.clone().set_border(FormatBorder::Thin);
    for (column, field) in fields.iter().enumerate() {
        let key = string_value(field.get("key"));
        let label = string_value(field.get("label"));
        workbook
            .worksheet_from_name("资产导入")
            .map_err(|error| error.to_string())?
            .write_string_with_format(0, column as u16, &label, &header_format)
            .map_err(|error| error.to_string())?;
        for (index, value) in [
            "资产导入".to_owned(),
            column.to_string(),
            import_field_key(&key).to_owned(),
            label,
        ]
        .iter()
        .enumerate()
        {
            workbook
                .worksheet_from_name("_columns")
                .map_err(|error| error.to_string())?
                .write_string(column as u32, index as u16, value)
                .map_err(|error| error.to_string())?;
        }
        let mut options = field
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if options.is_empty() {
            if import_field_key(&key) == "rotatePassword" || string_value(field.get("type")) == "boolean" {
                options = vec!["是".to_owned(), "否".to_owned()];
            } else if key == "status" {
                options = ["生产", "测试", "关机", "待切换"].map(str::to_owned).to_vec();
            }
        }
        if !options.is_empty() {
            for (row, option) in options.iter().enumerate() {
                workbook
                    .worksheet_from_name("_lists")
                    .map_err(|error| error.to_string())?
                    .write_string(row as u32, column as u16, option)
                    .map_err(|error| error.to_string())?;
            }
            let range = format!(
                "=_lists!{}",
                rust_xlsxwriter::utility::cell_range_absolute(
                    0,
                    column as u16,
                    options.len() as u32 - 1,
                    column as u16
                )
            );
            let name = format!("AssetOpsChoices{column}");
            workbook
                .define_name(&name, &range)
                .map_err(|error| error.to_string())?;
            let validation =
                DataValidation::new().allow_list_formula(format!("={name}").as_str().into());
            workbook
                .worksheet_from_name("资产导入")
                .map_err(|error| error.to_string())?
                .add_data_validation(2, column as u16, 1_048_575, column as u16, &validation)
                .map_err(|error| error.to_string())?;
        }
    }
    {
        let worksheet = workbook.worksheet_from_name("资产导入").map_err(|error| error.to_string())?;
        worksheet.set_row_height(0, 24).map_err(|error| error.to_string())?;
        worksheet.set_row_height(1, 48).map_err(|error| error.to_string())?;
        for (column, field) in fields.iter().enumerate() {
            let field_key = string_value(field.get("key"));
            let key = import_field_key(&field_key);
            let configured_note = string_value(field.get("templateNote"));
            let note = if configured_note.trim().is_empty() { "/".to_owned() } else {
                configured_note.trim().replace("\r\n", "\n").replace(['“', '”', '＂'], "\"")
            };
            worksheet.write_string_with_format(1, column as u16, &note, &note_format).map_err(|error| error.to_string())?;
            let label = string_value(field.get("label"));
            let label_units = label
                .chars()
                .map(|ch| if ch.len_utf8() > 1 { 2.0_f64 } else { 1.0 })
                .sum::<f64>();
            let width = match key {
                "cpu" => 10.0,
                "memory" => 10.0,
                "disks" | "businessSystem" | "ip" | "ip2" => 18.0,
                "host" => 24.0,
                "name" | "os" => 22.0,
                "accounts" | "passwords" => 20.0,
                _ => (label_units + 3.0).clamp(16.0, 24.0),
            };
            worksheet.set_column_width(column as u16, width).map_err(|error| error.to_string())?;
            let column_format = if string_value(field.get("type")) == "integer" || matches!(key, "cpu" | "memory" | "passwordCycleDays") {
                data_format.clone()
            } else {
                data_format.clone().set_num_format_index(49)
            };
            worksheet.set_column_format(column as u16, &column_format).map_err(|error| error.to_string())?;
            for row in 2..=200 {
                worksheet.write_blank(row, column as u16, &column_format).map_err(|error| error.to_string())?;
            }
        }
        worksheet.set_freeze_panes(2, 0).map_err(|error| error.to_string())?;
        worksheet.protect_with_options(&ProtectionOptions {
            format_cells: true,
            format_columns: true,
            format_rows: true,
            insert_rows: true,
            delete_rows: true,
            ..ProtectionOptions::default()
        });
    }
    Ok(workbook)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn export_template(window: tauri::WebviewWindow,
    fields: Vec<Value>,
    state: tauri::State<'_, VaultState>,
) -> Result<ExportFile, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    if fields.is_empty() { return Err("所选系统还没有保存字段，请先配置字段模板".into()); }
    let _operation = state.begin_operation()?;
    let data = vault::read_unlocked(&state)?;
    let mut workbook = template_workbook(&data, &fields)?;
    let path = unique_export_path(&export_directory(&state)?, "资产导入模板");
    workbook.save(&path).map_err(|error| error.to_string())?;
    Ok(ExportFile {
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        rows: 0,
    })
}

fn column_key_part(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn build_export_headers(data: &Value, system_id: &str, include_passwords: bool, visible_columns: Option<&HashSet<String>>) -> Vec<String> {
    let defined = fields_for_system(data, system_id);
    let is_visible = |key: &str| {
        visible_columns.is_none_or(|visible| {
            let definition_key = if key == "passwordUpdatedAt" { "user" } else { field_key(key) };
            let field = defined.iter().find(|field| field.get("key").and_then(Value::as_str) == Some(definition_key));
            field.is_some_and(|field| field.get("showInList").and_then(Value::as_bool).unwrap_or(true))
                && (visible.contains(key)
                    || (key == "passwords" && visible.contains("password"))
                    || (key == "passwordUpdatedAt" && visible.contains("accounts")))
        })
    };
    let mut export_headers = ["businessSystem", "name", "host"].into_iter()
        .filter(|key| is_visible(key)).map(str::to_owned).collect::<Vec<_>>();
    for key in [
        "ip",
        "ip2",
        "status",
        "cpu",
        "memory",
        "os",
        "disks",
        "asset:tags",
        "accounts",
        "passwordUpdatedAt",
        "rotatePassword",
        "passwordCycleDays",
        "createdAt",
        "updatedAt",
    ] {
        let optional = matches!(key, "ip2" | "rotatePassword" | "passwordCycleDays");
        if is_visible(key)
            && (!optional
                || defined.iter().any(|field| {
                    field.get("key").and_then(Value::as_str) == Some(field_key(key))
                }))
        {
            export_headers.push(key.to_owned());
        }
    }
    if include_passwords && is_visible("passwords") {
        let position = export_headers
            .iter()
            .position(|header| header == "passwordUpdatedAt")
            .unwrap_or(export_headers.len());
        export_headers.insert(position, "passwords".to_owned());
    }
    let reserved = [
        "business_system",
        "name",
        "host",
        "ip_1",
        "ip_2",
        "status",
        "cpu",
        "mem",
        "disks",
        "os",
        "user",
        "password",
        "updated_at",
        "created_at",
        "pwd_rotate",
        "pwd_cycle_days",
    ];
    for field in fields_for_system(&data, system_id) {
        let key = string_value(field.get("key"));
        if !reserved.contains(&key.as_str())
            && (include_passwords
                || field.get("type").and_then(Value::as_str) != Some("password"))
            && visible_columns
                .as_ref()
                .is_none_or(|visible| visible.contains(&format!("custom:{key}")) && field.get("showInList").and_then(Value::as_bool).unwrap_or(true))
        {
            export_headers.push(key);
        }
    }
    let settings = data.pointer("/settings/tableColumns").and_then(Value::as_array)
        .into_iter().flatten().filter_map(|column| Some((column.get("key")?.as_str()?, column.get("sortOrder")?.as_i64()?)))
        .collect::<HashMap<_, _>>();
    export_headers.sort_by_cached_key(|key| {
        let Some((index, field)) = defined.iter().enumerate().find(|(_, field)| field.get("key").and_then(Value::as_str) == Some(field_key(key))) else { return i64::MAX; };
        let canonical = format!("field:{}:{}:{}", column_key_part(&string_value(field.get("key"))), string_value(field.get("type")), column_key_part(&string_value(field.get("label"))));
        let legacy = match key.as_str() {
            "passwords" => "password", "rotatePassword" => "pwdRotate", "passwordCycleDays" => "pwdCycle", "pwd_expire_at" => "passwordExpiry", _ => key,
        };
        settings.get(canonical.as_str()).or_else(|| settings.get(legacy)).or_else(|| settings.get(format!("custom:{key}").as_str())).copied().unwrap_or(index as i64)
    });
    export_headers.extend([
        "unit".to_owned(),
        "environment".to_owned(),
        "zone".to_owned(),
        "system".to_owned(),
    ]);
    export_headers
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn export_assets(window: tauri::WebviewWindow,
    system_id: Option<String>,
    asset_ids: Option<Vec<String>>,
    template_only: bool,
    include_passwords: bool,
    include_field_descriptions: bool,
    include_history: bool,
    visible_columns: Option<Vec<String>>,
    state: tauri::State<'_, VaultState>,
) -> Result<ExportFile, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    export_assets_file(system_id, asset_ids, template_only, include_passwords, include_field_descriptions, include_history, visible_columns, &state)
}

fn export_assets_file(
    system_id: Option<String>, asset_ids: Option<Vec<String>>, template_only: bool,
    include_passwords: bool, include_field_descriptions: bool, include_history: bool,
    visible_columns: Option<Vec<String>>, state: &VaultState,
) -> Result<ExportFile, String> {
    let _operation = state.begin_operation()?;
    let data = vault::read_unlocked(&state)?;
    let (systems, environments, zones, system_paths) = structure_names(&data);
    let selected_ids = asset_ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
    let assets = data
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|asset| {
            if template_only {
                return false;
            }
            let asset_system_id = string_value(asset.get("systemId"));
            let id = string_value(asset.get("id"));
            system_id
                .as_ref()
                .is_none_or(|expected| *expected == asset_system_id)
                && selected_ids
                    .as_ref()
                    .is_none_or(|expected| expected.contains(&id))
        })
        .collect::<Vec<_>>();

    let mut grouped = HashMap::<String, Vec<&Value>>::new();
    for asset in &assets {
        grouped
            .entry(string_value(asset.get("systemId")))
            .or_default()
            .push(asset);
    }
    if grouped.is_empty() {
        grouped.insert(system_id.unwrap_or_default(), Vec::new());
    }

    let selected_asset_ids = assets
        .iter()
        .map(|asset| string_value(asset.get("id")))
        .collect::<HashSet<_>>();
    let visible_columns = visible_columns.map(|values| values.into_iter().collect::<HashSet<_>>());
    let mut group_ids = grouped.keys().cloned().collect::<Vec<_>>();
    group_ids.sort_by_key(|id| {
        systems
            .get(id)
            .map(|(_, name)| (name.clone(), id.clone()))
            .unwrap_or_else(|| (String::new(), id.clone()))
    });

    let mut workbook = Workbook::new();
    let data_format = Format::new().set_font_name("Microsoft YaHei").set_font_color(Color::Black).set_num_format_index(49).set_align(FormatAlign::Center).set_align(FormatAlign::VerticalCenter);
    let header_format = data_format.clone().set_bold().set_background_color(Color::RGB(0xE3EFE9));
    let mut used_sheet_names = ["_meta", "_columns", "_systems", "_lists", "字段说明", "变更历史"].into_iter().map(str::to_owned).collect::<HashSet<_>>();
    let mut sheet_names = HashMap::new();
    let mut column_metadata = Vec::<(String, usize, String, String)>::new();
    for group_system_id in &group_ids {
        let rows = grouped.get(group_system_id).cloned().unwrap_or_default();
        let (unit_name, system_name) = systems
            .get(group_system_id)
            .cloned()
            .unwrap_or_else(|| (String::new(), "资产".to_owned()));
        let worksheet = workbook.add_worksheet();
        let sheet_path = system_paths.get(group_system_id)
            .map(|path| path.iter().skip(1).filter(|name| !name.is_empty()).cloned().collect::<Vec<_>>().join("-"))
            .unwrap_or_else(|| system_name.clone());
        let name = sheet_name(&sheet_path, &mut used_sheet_names);
        sheet_names.insert(group_system_id.clone(), name.clone());
        worksheet
            .set_name(name)
            .map_err(|error| error.to_string())?;
        let export_headers = build_export_headers(&data, group_system_id, include_passwords, visible_columns.as_ref());
        let mut widths = vec![0; export_headers.len()];
        for (column, header) in export_headers.iter().enumerate() {
            let label = export_label(&data, group_system_id, header);
            column_metadata.push((
                sheet_names[group_system_id].clone(),
                column,
                header.clone(),
                label.clone(),
            ));
            write_export_cell(worksheet, 0, column as u16, &label, &header_format, &mut widths)?;
        }
        for (index, asset) in rows.iter().enumerate() {
            let (accounts, passwords, password_updated_at) =
                account_columns(asset, include_passwords);
            let environment = environments
                .get(&string_value(asset.get("environmentId")))
                .cloned()
                .unwrap_or_default();
            let zone = zones
                .get(&string_value(asset.get("zoneId")))
                .cloned()
                .unwrap_or_default();
            let values = export_headers
                .iter()
                .map(|header| match header.as_str() {
                    "name" | "host" | "status" | "cpu" | "os" => {
                        string_value(asset_value(asset, header))
                    }
                    "createdAt" | "updatedAt" => export_datetime(&string_value(asset_value(asset, header))),
                    "ip" => string_value(
                        asset_value(asset, "ip").or_else(|| asset_value(asset, "ip_1")),
                    ),
                    "ip2" => string_value(
                        asset_value(asset, "ip2").or_else(|| asset_value(asset, "ip_2")),
                    ),
                    "memory" => string_value(
                        asset_value(asset, "memory").or_else(|| asset_value(asset, "mem")),
                    ),
                    "disks" => joined_disks(asset),
                    "asset:tags" => joined_tags(asset),
                    "accounts" => accounts.clone(),
                    "passwords" => passwords.clone(),
                    "passwordUpdatedAt" => password_updated_at.clone(),
                    "rotatePassword" => string_value(
                        asset_value(asset, "rotatePassword")
                            .or_else(|| asset_value(asset, "pwd_rotate")),
                    ),
                    "passwordCycleDays" => string_value(
                        asset_value(asset, "passwordCycleDays")
                            .or_else(|| asset_value(asset, "pwd_cycle_days")),
                    ),
                    "unit" => unit_name.clone(),
                    "environment" => environment.clone(),
                    "zone" => zone.clone(),
                    "system" => system_name.clone(),
                    "businessSystem" => string_value(asset_value(asset, "businessSystem")),
                    key => custom_value(asset, key),
                })
                .collect::<Vec<_>>();
            for (column, value) in values.iter().enumerate() {
                write_export_cell(worksheet, (index + 1) as u32, column as u16, value, &data_format, &mut widths)?;
            }
        }
        worksheet.set_freeze_panes(1, 0).map_err(|error| error.to_string())?;
        fit_export_columns(worksheet, &widths)?;
    }

    if include_field_descriptions {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name("字段说明")
            .map_err(|error| error.to_string())?;
        let headers = [
            "systemId",
            "unit",
            "system",
            "key",
            "label",
            "type",
            "required",
            "unique",
            "defaultValue",
            "validation",
            "width",
            "showInList",
        ];
        let mut widths = vec![0; headers.len()];
        for (column, header) in headers.iter().enumerate() {
            write_export_cell(worksheet, 0, column as u16, header, &header_format, &mut widths)?;
        }
        let mut row = 1_u32;
        for group_system_id in &group_ids {
            let (unit_name, system_name) =
                systems.get(group_system_id).cloned().unwrap_or_default();
            for field in fields_for_system(&data, group_system_id) {
                let values = [
                    group_system_id.clone(),
                    unit_name.clone(),
                    system_name.clone(),
                    string_value(field.get("key")),
                    string_value(field.get("label")),
                    string_value(field.get("type")),
                    string_value(field.get("required")),
                    string_value(field.get("unique")),
                    if !include_passwords
                        && field.get("type").and_then(Value::as_str) == Some("password")
                    {
                        "[敏感字段已隐藏]".to_owned()
                    } else {
                        string_value(field.get("defaultValue"))
                    },
                    string_value(field.get("validation")),
                    string_value(field.get("width")),
                    string_value(field.get("showInList")),
                ];
                for (column, value) in values.iter().enumerate() {
                    write_export_cell(worksheet, row, column as u16, value, &data_format, &mut widths)?;
                }
                row += 1;
            }
        }
        worksheet.set_freeze_panes(1, 0).map_err(|error| error.to_string())?;
        fit_export_columns(worksheet, &widths)?;
    }

    if include_history {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name("变更历史")
            .map_err(|error| error.to_string())?;
        let headers = [
            "changeId", "time", "object", "action", "source", "batchId", "field", "before",
            "after", "note",
        ];
        let mut widths = vec![0; headers.len()];
        for (column, header) in headers.iter().enumerate() {
            write_export_cell(worksheet, 0, column as u16, header, &header_format, &mut widths)?;
        }
        let selected_system_ids = group_ids.iter().cloned().collect::<HashSet<_>>();
        let mut row = 1_u32;
        for record in data
            .get("history")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|record| {
                selected_asset_ids.contains(&string_value(record.get("assetId")))
                    || selected_system_ids.contains(&string_value(record.get("systemId")))
            })
        {
            let items = record
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let items = if items.is_empty() {
                vec![json!({})]
            } else {
                items
            };
            for item in items {
                let values = [
                    string_value(record.get("id")),
                    export_datetime(&string_value(record.get("at"))),
                    string_value(record.get("objectName").or_else(|| record.get("assetName"))),
                    string_value(record.get("action")),
                    string_value(record.get("source")),
                    string_value(record.get("batchId")),
                    string_value(item.get("fieldLabel").or_else(|| item.get("fieldKey"))),
                    audit_value(&item, "before", false),
                    audit_value(&item, "after", false),
                    string_value(record.get("note")),
                ];
                for (column, value) in values.iter().enumerate() {
                    write_export_cell(worksheet, row, column as u16, value, &data_format, &mut widths)?;
                }
                row += 1;
            }
        }
        worksheet.set_freeze_panes(1, 0).map_err(|error| error.to_string())?;
        fit_export_columns(worksheet, &widths)?;
    }

    let columns_sheet = workbook.add_worksheet();
    columns_sheet
        .set_name("_columns")
        .map_err(|error| error.to_string())?;
    for (row, (sheet, column, key, label)) in column_metadata.iter().enumerate() {
        for (index, value) in [
            sheet.clone(),
            column.to_string(),
            key.clone(),
            label.clone(),
        ]
        .iter()
        .enumerate()
        {
            columns_sheet
                .write_string(row as u32, index as u16, value)
                .map_err(|error| error.to_string())?;
        }
    }
    columns_sheet.set_hidden(true);
    let meta = workbook.add_worksheet();
    meta.set_name("_meta").map_err(|error| error.to_string())?;
    meta.write_string(0, 0, "schema_version")
        .map_err(|error| error.to_string())?;
    meta.write_string(0, 1, "2")
        .map_err(|error| error.to_string())?;
    meta.write_string(1, 0, "exported_at")
        .map_err(|error| error.to_string())?;
    meta.write_string(1, 1, Local::now().to_rfc3339())
        .map_err(|error| error.to_string())?;
    meta.write_string(2, 0, "passwords_included")
        .map_err(|error| error.to_string())?;
    meta.write_string(2, 1, if include_passwords { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    meta.write_string(3, 0, "internal_sheets").map_err(|error| error.to_string())?;
    let mut internal_sheets = vec!["_meta", "_columns"];
    if include_field_descriptions { internal_sheets.push("字段说明"); }
    if include_history { internal_sheets.push("变更历史"); }
    meta.write_string(3, 1, serde_json::to_string(&internal_sheets).unwrap()).map_err(|error| error.to_string())?;
    for (column, header) in [
        "system_id",
        "unit",
        "system",
        "field_fingerprint",
        "sheet_name",
    ]
    .iter()
    .enumerate()
    {
        meta.write_string(4, column as u16, *header)
            .map_err(|error| error.to_string())?;
    }
    for (index, group_system_id) in group_ids.iter().enumerate() {
        let (unit_name, system_name) = systems.get(group_system_id).cloned().unwrap_or_default();
        let values = [
            group_system_id.clone(),
            unit_name,
            system_name,
            field_fingerprint(&data, group_system_id),
            sheet_names
                .get(group_system_id)
                .cloned()
                .unwrap_or_default(),
        ];
        for (column, value) in values.iter().enumerate() {
            meta.write_string((index + 5) as u32, column as u16, value)
                .map_err(|error| error.to_string())?;
        }
    }
    meta.set_hidden(true);

    let unit_names = group_ids.iter().filter_map(|id| systems.get(id).map(|(unit, _)| unit.trim())).filter(|name| !name.is_empty()).collect::<HashSet<_>>();
    let unit_name = if unit_names.len() == 1 { *unit_names.iter().next().unwrap() } else if unit_names.is_empty() { "未归属单位" } else { "多单位" };
    let unit_name = unit_name.chars().map(|character| if character.is_control() || "<>:\"/\\|?*".contains(character) { '_' } else { character }).collect::<String>();
    let prefix = format!("{}_{}", unit_name.trim_end_matches(['.', ' ']), if template_only { "资产台账-空模板" } else { "资产台账-导出" });
    let path = unique_export_path(&export_directory(&state)?, &prefix);
    workbook.save(&path).map_err(|error| error.to_string())?;
    Ok(ExportFile {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
        path: path.to_string_lossy().into_owned(),
        rows: assets.len(),
    })
}

#[tauri::command(async)]
pub fn export_audit(window: tauri::WebviewWindow, state: tauri::State<'_, VaultState>, include_passwords: Option<bool>) -> Result<ExportFile, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    let _operation = state.begin_operation()?;
    export_audit_file(&state, include_passwords.unwrap_or(false))
}

fn export_audit_file(state: &VaultState, include_passwords: bool) -> Result<ExportFile, String> {
    let data = vault::read_unlocked(&state)?;
    let history = data
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name("变更历史")
        .map_err(|error| error.to_string())?;
    let headers = [
        "id",
        "time",
        "objectType",
        "objectId",
        "objectName",
        "action",
        "source",
        "batchId",
        "fieldKey",
        "fieldLabel",
        "before",
        "after",
        "note",
    ];
    for (column, header) in headers.iter().enumerate() {
        worksheet
            .write_string(0, column as u16, *header)
            .map_err(|error| error.to_string())?;
    }
    let mut row = 1_u32;
    for record in &history {
        let items = record
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let items = if items.is_empty() {
            vec![json!({})]
        } else {
            items
        };
        for item in items {
            let values = [
                string_value(record.get("id")),
                string_value(record.get("at")),
                string_value(record.get("objectType")),
                string_value(record.get("objectId").or_else(|| record.get("assetId"))),
                string_value(record.get("objectName").or_else(|| record.get("assetName"))),
                string_value(record.get("action")),
                string_value(record.get("source")),
                string_value(record.get("batchId")),
                string_value(item.get("fieldKey")),
                string_value(item.get("fieldLabel")),
                audit_value(&item, "before", include_passwords),
                audit_value(&item, "after", include_passwords),
                string_value(record.get("note")),
            ];
            for (column, value) in values.iter().enumerate() {
                worksheet
                    .write_string(row, column as u16, value)
                    .map_err(|error| error.to_string())?;
            }
            row += 1;
        }
    }
    worksheet.autofit();
    let path = unique_export_path(&export_directory(&state)?, "变更审计-导出");
    workbook.save(&path).map_err(|error| error.to_string())?;
    Ok(ExportFile {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
        path: path.to_string_lossy().into_owned(),
        rows: row.saturating_sub(1) as usize,
    })
}

fn cell_text(cell: Option<&Data>) -> String {
    cell.map(ToString::to_string)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn canonical_header(header: &str) -> Option<&'static str> {
    let normalized = header
        .trim()
        .to_ascii_lowercase()
        .replace([' ', '_', '-'], "");
    match normalized.as_str() {
        "name" | "服务器名称" | "名称" => Some("name"),
        "host" | "hostname" | "主机名" => Some("host"),
        "ip" | "ip1" | "主ip" | "主ip地址" => Some("ip"),
        "ip2" | "备用ip" | "备用ip地址" => Some("ip2"),
        "status" | "状态" | "统计分类" | "服务器状态" => Some("status"),
        "cpu" | "cpu核数" => Some("cpu"),
        "memory" | "mem" | "内存" => Some("memory"),
        "os" | "操作系统" => Some("os"),
        "disks" | "disk" | "磁盘" | "硬盘" => Some("disks"),
        "asset:tags" | "assettags" | "assettag" | "资产标签" => Some("asset:tags"),
        "accounts" | "account" | "user" | "账号" | "用户" => Some("accounts"),
        "passwords" | "password" | "密码" => Some("passwords"),
        "passwordupdatedat" | "密码修改日期" => Some("passwordUpdatedAt"),
        "rotatepassword" | "pwdrotate" | "定期修改密码" => Some("rotatePassword"),
        "passwordcycledays" | "pwdcycledays" | "密码更新周期" => Some("passwordCycleDays"),
        "unit" | "单位" => Some("unit"),
        "environment" | "env" | "环境" => Some("environment"),
        "zone" | "网络区域" | "区域" => Some("zone"),
        "system" | "系统" => Some("system"),
        "businesssystem" | "业务系统" => Some("businessSystem"),
        "createdat" | "创建日期" => Some("createdAt"),
        "updatedat" | "修改日期" => Some("updatedAt"),
        _ => None,
    }
}

fn split_values(value: &str) -> Vec<String> {
    value
        .split([';', '；', '\n', '\r'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_disks(value: &str) -> Result<Vec<Value>, String> {
    split_values(value)
        .into_iter()
        .map(|item| {
            let mut parts = item.splitn(2, [':', '|']);
            let label = parts.next().unwrap_or_default().trim();
            let capacity_text = parts
                .next()
                .ok_or_else(|| format!("磁盘“{item}”缺少容量"))?
                .trim();
            let unit_start = capacity_text.find(|ch: char| ch.is_ascii_alphabetic()).unwrap_or(capacity_text.len());
            let unit = capacity_text[unit_start..].trim().to_ascii_uppercase();
            if !["", "B", "K", "KB", "KIB", "M", "MB", "MIB", "G", "GB", "GIB", "T", "TB", "TIB", "P", "PB", "PIB", "E", "EB", "EIB"].contains(&unit.as_str()) {
                return Err(format!("磁盘“{item}”容量单位无效"));
            }
            let capacity = capacity_text[..unit_start].trim().parse::<f64>()
                .map_err(|_| format!("磁盘“{item}”容量不是数字"))?;
            if label.is_empty() || !capacity.is_finite() || capacity <= 0.0 { return Err(format!("磁盘“{item}”容量或标识无效")); }
            Ok(json!({ "label": label, "capacity": capacity, "unit": unit }))
        })
        .collect()
}

fn parse_accounts(usernames: &str, passwords: &str, updated_dates: &str) -> Result<Vec<Value>, String> {
    let split_aligned = |value: &str| {
        value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split([';', '；', '\n'])
            .map(|item| item.trim().to_owned())
            .collect::<Vec<_>>()
    };
    let mut usernames = split_aligned(usernames).into_iter().filter(|name| !name.is_empty()).collect::<Vec<_>>();
    if usernames.is_empty() { usernames.push("root".into()); }
    let passwords = if usernames.len() <= 1 {
        vec![passwords.to_owned()]
    } else if passwords.is_empty() {
        vec![String::new(); usernames.len()]
    } else {
        serde_json::from_str::<Vec<String>>(passwords)
            .unwrap_or_else(|_| passwords.replace("\r\n", "\n").replace('\r', "\n").split('\n').map(str::to_owned).collect())
    };
    let dates = split_aligned(updated_dates);
    if passwords.len() != usernames.len() { return Err(format!("账号和密码数量不一致（{} 个账号、{} 个密码），多密码请使用逐行或 JSON 数组格式", usernames.len(), passwords.len())); }
    if dates.len() != 1 && dates.len() != usernames.len() { return Err("账号和密码修改日期数量不一致".into()); }
    Ok(usernames
        .into_iter()
        .enumerate()
        .filter(|(_, username)| !username.is_empty())
        .map(|(index, username)| {
            json!({
                "username": username,
                "password": passwords.get(index).cloned().unwrap_or_default(),
                "passwordUpdatedAt": dates.get(index).cloned().or_else(|| dates.first().cloned()).unwrap_or_default()
            })
        })
        .collect())
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" | "是" => Some(true),
        "false" | "0" | "no" | "n" | "否" | "" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
fn parse_import_bytes(
    bytes: impl AsRef<[u8]>,
    column_mapping: &HashMap<String, String>,
) -> Result<ImportParseResult, String> {
    parse_import_with_mappings(bytes, column_mapping, &HashMap::new())
}

const MAX_IMPORT_BYTES: usize = 64 * 1024 * 1024;
fn validate_import_size(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_IMPORT_BYTES { return Err("Excel 文件不能超过 64 MB".into()); }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Excel 文件格式无效")?;
    if archive.len() > 4096 { return Err("Excel 文件内部条目过多".into()); }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let size = archive.by_index(index).map_err(|_| "Excel 文件已损坏")?.size();
        total = total.checked_add(size).ok_or("Excel 解压内容过大")?;
        if total > 256 * 1024 * 1024 { return Err("Excel 解压内容不能超过 256 MB".into()); }
    }
    Ok(())
}

fn parse_import_with_mappings(
    bytes: impl AsRef<[u8]>, column_mapping: &HashMap<String, String>, sheet_column_mapping: &HashMap<String, HashMap<String, String>>,
) -> Result<ImportParseResult, String> {
    validate_import_size(bytes.as_ref())?;
    let cursor = Cursor::new(bytes);
    let mut workbook = Xlsx::new(cursor).map_err(|error| error.to_string())?;
    let mut metadata = Map::new();
    if let Some(range) = workbook.worksheet_range("_meta").ok().filter(|range| matches!(cell_text(range.rows().next().and_then(|row| row.first())).as_str(), "schema_version" | "noteRow")) {
        for row in range.rows().take(4) {
            let key = cell_text(row.first());
            if !key.is_empty() {
                metadata.insert(key, Value::String(cell_text(row.get(1))));
            }
        }
        let systems = range
            .rows()
            .skip(5)
            .filter_map(|row| {
                let system_id = cell_text(row.first());
                if system_id.is_empty() {
                    return None;
                }
                Some(json!({
                    "systemId": system_id,
                    "unit": cell_text(row.get(1)),
                    "system": cell_text(row.get(2)),
                    "fieldFingerprint": cell_text(row.get(3)),
                    "sheetName": cell_text(row.get(4))
                }))
            })
            .collect::<Vec<_>>();
        metadata.insert("systems".to_owned(), Value::Array(systems));
    }
    let mut exported_columns = HashMap::new();
    if let Ok(range) = workbook.worksheet_range("_systems") {
        metadata.insert(
            "systemChoices".to_owned(),
            json!(range
                .rows()
                .map(|row| json!({
                    "label": cell_text(row.first()), "systemId": cell_text(row.get(1)),
                    "unit": cell_text(row.get(2)), "system": cell_text(row.get(3))
                }))
                .collect::<Vec<_>>()),
        );
    }
    if let Ok(range) = workbook.worksheet_range("_columns") {
        for row in range.rows() {
            if let Ok(column) = cell_text(row.get(1)).parse::<usize>() {
                exported_columns.insert(
                    (cell_text(row.first()), column),
                    (cell_text(row.get(2)), cell_text(row.get(3))),
                );
            }
        }
    }
    let has_note_row = metadata.contains_key("noteRow");
    let internal_sheets = metadata.get("internal_sheets").and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok());
    let data_sheets = exported_columns.keys().map(|(sheet, _)| sheet.clone()).collect::<HashSet<_>>();
    let mut parsed_rows = Vec::new();
    let mut errors = Vec::new();
    let mut unmapped_headers = HashSet::new();
    let mut source_headers = HashSet::new();
    let mut sheet_headers = HashMap::new();
    for sheet in workbook.sheet_names().to_vec() {
        let internal = internal_sheets.as_ref().map_or_else(
            || (metadata.contains_key("schema_version") || has_note_row) && matches!(sheet.as_str(), "_meta" | "_columns" | "_systems" | "_lists" | "字段说明" | "变更历史") && !data_sheets.contains(&sheet),
            |names| names.contains(&sheet),
        );
        if internal || (sheet == "_columns" && !exported_columns.is_empty()) {
            continue;
        }
        let range = workbook
            .worksheet_range(&sheet)
            .map_err(|error| error.to_string())?;
        let mut rows = range.rows();
        let Some(header_row) = rows.next() else {
            continue;
        };
        sheet_headers.insert(sheet.clone(), header_row.iter().map(|cell| cell.to_string().trim().to_owned()).filter(|header| !header.is_empty()).collect());
        let mapped_column = |header: &str| sheet_column_mapping.get(&sheet).and_then(|mapping| mapping.get(header)).or_else(|| column_mapping.get(header));
        if has_note_row {
            rows.next();
        }
        let headers = header_row
            .iter()
            .enumerate()
            .filter_map(|(index, cell)| {
                let header = cell.to_string().trim().to_owned();
                if header.is_empty() {
                    return None;
                }
                source_headers.insert(header.clone());
                if mapped_column(&header)
                    .is_some_and(|target| target == "__ignore__")
                {
                    return None;
                }
                let key = mapped_column(&header)
                    .map(String::as_str)
                    .or_else(|| {
                        exported_columns
                            .get(&(sheet.clone(), index))
                            .filter(|(_, label)| label == &header)
                            .map(|(key, _)| key.as_str())
                    })
                    .or_else(|| canonical_header(&header))
                    .map(|key| import_field_key(key).to_owned())
                    .unwrap_or_else(|| {
                        unmapped_headers.insert(header.clone());
                        header
                    });
                Some((index, key))
            })
            .collect::<Vec<_>>();
        if !headers.iter().any(|(_, key)| key == "host") {
            errors.push(ImportError {
                sheet: sheet.clone(),
                row_number: 1,
                column: "host".to_owned(),
                message: "缺少 host/主机名列，请在列映射中指定主机名".to_owned(),
            });
        }
        for (offset, row) in rows.enumerate() {
            let row_number = offset + if has_note_row { 3 } else { 2 };
            if cell_text(row.first()) == "【填写说明】" {
                continue;
            }
            let mut raw = HashMap::new();
            for (index, key) in &headers {
                let value = if key == "passwords" {
                    row.get(*index).map(ToString::to_string).unwrap_or_default()
                } else { cell_text(row.get(*index)) };
                raw.insert(key.clone(), value);
            }
            if raw.values().all(String::is_empty) {
                continue;
            }
            let name = raw.get("name").cloned().unwrap_or_default();
            let host = raw.get("host").cloned().unwrap_or_default();
            if host.is_empty() {
                errors.push(ImportError {
                    sheet: sheet.clone(),
                    row_number,
                    column: "host".to_owned(),
                    message: "主机名不能为空".to_owned(),
                });
            }
            let ip = raw.get("ip").cloned().unwrap_or_default();
            if !ip.is_empty() && ip.parse::<IpAddr>().is_err() {
                errors.push(ImportError {
                    sheet: sheet.clone(),
                    row_number,
                    column: "ip".to_owned(),
                    message: format!("“{ip}”不是合法 IPv4/IPv6 地址"),
                });
            }
            let status = raw.get("status").cloned().unwrap_or_default();
            let status = if status == "关机/下电" { "关机".to_owned() } else { status };
            if !status.is_empty() && !matches!(status.as_str(), "生产" | "测试" | "关机" | "待切换")
            {
                errors.push(ImportError {
                    sheet: sheet.clone(),
                    row_number,
                    column: "status".to_owned(),
                    message: "状态必须是生产、测试、关机或待切换".to_owned(),
                });
            }
            let parse_number = |key: &'static str, errors: &mut Vec<ImportError>| -> Option<f64> {
                let value = raw.get(key).cloned().unwrap_or_default();
                if value.is_empty() {
                    return None;
                }
                match value.parse::<f64>() {
                    Ok(value) => Some(value),
                    Err(_) => {
                        errors.push(ImportError {
                            sheet: sheet.clone(),
                            row_number,
                            column: key.to_owned(),
                            message: format!("“{value}”不是数字"),
                        });
                        None
                    }
                }
            };
            let disks = match parse_disks(raw.get("disks").map(String::as_str).unwrap_or_default())
            {
                Ok(disks) => disks,
                Err(message) => {
                    errors.push(ImportError {
                        sheet: sheet.clone(),
                        row_number,
                        column: "disks".to_owned(),
                        message,
                    });
                    Vec::new()
                }
            };
            let rotate_password = raw
                .get("rotatePassword")
                .and_then(|value| parse_bool(value));
            let accounts = match parse_accounts(raw.get("accounts").map(String::as_str).unwrap_or_default(), raw.get("passwords").map(String::as_str).unwrap_or_default(), raw.get("passwordUpdatedAt").map(String::as_str).unwrap_or_default()) {
                Ok(accounts) => accounts,
                Err(message) => { errors.push(ImportError { sheet: sheet.clone(), row_number, column: "accounts".into(), message }); Vec::new() }
            };
            if raw
                .get("rotatePassword")
                .is_some_and(|value| !value.is_empty() && rotate_password.is_none())
            {
                errors.push(ImportError {
                    sheet: sheet.clone(),
                    row_number,
                    column: "rotatePassword".to_owned(),
                    message: "定期修改密码应为是/否或 true/false".to_owned(),
                });
            }
            let mut object = Map::new();
            object.insert("sheet".to_owned(), json!(sheet));
            object.insert("rowNumber".to_owned(), json!(row_number));
            object.insert(
                "presentColumns".to_owned(),
                json!(headers.iter().map(|(_, key)| key).collect::<Vec<_>>()),
            );
            object.insert("name".to_owned(), json!(name));
            object.insert("host".to_owned(), json!(host));
            object.insert("tags".to_owned(), json!(raw.get("asset:tags").map(String::as_str).unwrap_or_default().split([',', '，', ';', '；', '\n']).map(str::trim).filter(|value| !value.is_empty()).collect::<Vec<_>>()));
            object.insert("ip".to_owned(), json!(ip));
            object.insert(
                "ip2".to_owned(),
                json!(raw.get("ip2").cloned().unwrap_or_default()),
            );
            object.insert("status".to_owned(), json!(status));
            object.insert("cpu".to_owned(), json!(parse_number("cpu", &mut errors)));
            object.insert(
                "memory".to_owned(),
                json!(parse_number("memory", &mut errors)),
            );
            object.insert(
                "os".to_owned(),
                json!(raw.get("os").cloned().unwrap_or_default()),
            );
            object.insert("disks".to_owned(), json!(disks));
            object.insert(
                "accounts".to_owned(),
                json!(accounts),
            );
            object.insert(
                "rotatePassword".to_owned(),
                json!(rotate_password.unwrap_or(false)),
            );
            object.insert(
                "passwordCycleDays".to_owned(),
                json!(parse_number("passwordCycleDays", &mut errors)),
            );
            for key in ["unit", "system", "environment", "zone", "businessSystem"] {
                object.insert(
                    key.to_owned(),
                    json!(raw.get(key).cloned().unwrap_or_default()),
                );
            }
            for key in ["createdAt", "updatedAt"] {
                object.insert(
                    key.to_owned(),
                    json!(raw.get(key).cloned().unwrap_or_default()),
                );
            }
            let known = [
                "name",
                "host",
                "ip",
                "ip2",
                "status",
                "cpu",
                "memory",
                "os",
                "disks",
                "asset:tags",
                "accounts",
                "passwords",
                "passwordUpdatedAt",
                "rotatePassword",
                "passwordCycleDays",
                "unit",
                "system",
                "environment",
                "zone",
                "businessSystem",
                "createdAt",
                "updatedAt",
            ];
            let custom = raw
                .iter()
                .filter(|(key, _)| !known.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect::<Map<_, _>>();
            object.insert("custom".to_owned(), Value::Object(custom));
            parsed_rows.push(Value::Object(object));
        }
    }
    Ok(ImportParseResult {
        rows: parsed_rows,
        errors,
        metadata: Value::Object(metadata),
        sheet_headers,
        unmapped_headers: {
            let mut headers = unmapped_headers.into_iter().collect::<Vec<_>>();
            headers.sort();
            headers
        },
        headers: {
            let mut headers = source_headers.into_iter().collect::<Vec<_>>();
            headers.sort();
            headers
        },
    })
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn parse_import_xlsx(window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, VaultState>,
) -> Result<ImportParseResult, String> {
    crate::authorization::require_main(window.label())?;
    let _command = state.wait_for_command()?;
    parse_import_request(request.body(), request.headers())
}

fn parse_import_request(body: &tauri::ipc::InvokeBody, headers: &tauri::http::HeaderMap) -> Result<ImportParseResult, String> {
    let fallback;
    let bytes = match body {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(Value::Array(values)) => {
            if values.len() > MAX_IMPORT_BYTES { return Err("Excel 文件不能超过 64 MB".into()); }
            fallback = values.iter().map(|value| value.as_u64().and_then(|value| u8::try_from(value).ok()).ok_or("Excel 文件传输字节无效"))
                .collect::<Result<Vec<_>, _>>()?;
            fallback.as_slice()
        }
        _ => return Err("Excel 文件传输格式无效，请重新选择文件".into()),
    };
    let mapping = headers.get("x-column-mapping").map(|value| value.to_str().map_err(|_| "列映射格式无效"))
        .transpose()?.unwrap_or("{}");
    let mapping = serde_json::from_str(mapping).map_err(|_| "列映射格式无效")?;
    let sheets = headers.get("x-sheet-column-mapping").map(|value| value.to_str().map_err(|_| "工作表列映射格式无效"))
        .transpose()?.unwrap_or("{}");
    let sheets = serde_json::from_str(sheets).map_err(|_| "工作表列映射格式无效")?;
    parse_import_with_mappings(bytes, &mapping, &sheets)
}

#[cfg(test)]
mod tests {
    use super::{
        audit_value, build_export_headers, csv_cell, export_assets_file, export_cell_width, export_datetime, export_label, joined_disks, parse_accounts, parse_disks, parse_import_bytes, parse_import_request, sheet_name, template_workbook,
    };
    use calamine::{Reader, Xlsx};
    use rust_xlsxwriter::Workbook;
    use serde_json::json;
    use std::collections::HashMap;
    use std::io::Cursor;
    #[test]
    fn asset_tags_survive_workbook_round_trip() {
        let test = crate::vault::tests::TestVault::new("test", json!({"version":4,"units":[{"id":"u","name":"单位","environments":[{"id":"e","name":"环境","zones":[{"id":"z","name":"区域","systems":[{"id":"s","name":"系统"}]}]}]}],"assets":[{"id":"a","unitId":"u","environmentId":"e","zoneId":"z","systemId":"s","host":"node","tags":["生产","核心"],"custom":{"tags":"客户标签"}}],"fieldDefs":[{"id":"tag-field","systemId":"s","key":"tags","label":"业务标签","type":"text","sortOrder":0}]}));
        let mut data = crate::vault::read_unlocked(&test.state).unwrap();
        data["settings"] = json!({"exportDirectory":test.root.join("exports").to_string_lossy()});
        crate::vault::save_data(&data, &test.state).unwrap();
        let exported = export_assets_file(Some("s".to_owned()), None, false, false, false, false, None, &test.state).unwrap();
        let imported = parse_import_bytes(std::fs::read(&exported.path).unwrap(), &HashMap::new()).unwrap();
        assert!(imported.errors.is_empty());
        assert_eq!(imported.rows[0]["tags"], json!(["生产", "核心"]));
        assert!(imported.rows[0]["presentColumns"].as_array().unwrap().contains(&json!("asset:tags")));
        assert_eq!(imported.rows[0]["custom"]["tags"], json!("客户标签"));
        assert!(imported.rows[0]["custom"].get("asset:tags").is_none());
    }
    #[test]
    fn visible_export_matches_each_system_field_definition() {
        let data = json!({"fieldDefs": [
            {"systemId":"a","key":"host","showInList":true},
            {"systemId":"a","key":"ip_1","showInList":true},
            {"systemId":"a","key":"cpu","showInList":true},
            {"systemId":"a","key":"mem","showInList":true},
            {"systemId":"a","key":"disks","showInList":true},
            {"systemId":"a","key":"password","showInList":true},
            {"systemId":"a","key":"notes","type":"textarea","showInList":false},
            {"systemId":"b","key":"ip_1","showInList":false}
        ]});
        let keys = ["host", "ip", "cpu", "memory", "disks", "passwords", "custom:notes"].into_iter().map(str::to_owned).collect();
        let headers = build_export_headers(&data, "a", true, Some(&keys));
        for key in ["host", "ip", "cpu", "memory", "disks", "passwords"] { assert!(headers.iter().any(|header| header == key), "{key}"); }
        for key in ["name", "businessSystem", "ip2", "notes"] { assert!(!headers.iter().any(|header| header == key), "{key}"); }
        assert!(!build_export_headers(&data, "b", true, Some(&keys)).contains(&"ip".to_owned()));
        assert_eq!(build_export_headers(&data, "b", true, Some(&keys)), ["unit", "environment", "zone", "system"]);
        assert!(!build_export_headers(&data, "a", false, Some(&keys)).contains(&"passwords".to_owned()));
        assert!(build_export_headers(&data, "a", false, None).contains(&"notes".to_owned()));
    }

    #[test]
    fn sheet_mapping_keeps_notes_separate_and_exposes_source_headers() {
        let mut workbook = Workbook::new();
        for (sheet, host, notes) in [("甲表","host-a","# 运维备注\n\n**保留正文**"),("乙表","host-b","乙系统记录")] {
            let worksheet = workbook.add_worksheet(); worksheet.set_name(sheet).unwrap();
            worksheet.write_string(0,0,"主机名").unwrap(); worksheet.write_string(0,1,"备注").unwrap();
            worksheet.write_string(1,0,host).unwrap(); worksheet.write_string(1,1,notes).unwrap();
        }
        let bytes = workbook.save_to_buffer().unwrap();
        let initial = parse_import_bytes(&bytes,&HashMap::new()).unwrap();
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("x-sheet-column-mapping", r#"{"\u7532\u8868":{"\u5907\u6ce8":"notes"},"\u4e59\u8868":{"\u5907\u6ce8":"memo"}}"#.parse().unwrap());
        let parsed = parse_import_request(&tauri::ipc::InvokeBody::Raw(bytes.clone()), &headers).unwrap();
        assert!(parsed.errors.is_empty()); assert!(parsed.unmapped_headers.is_empty());
        assert_eq!(parsed.sheet_headers["甲表"],["主机名","备注"]);
        assert_eq!(parsed.rows[0]["custom"]["notes"],"# 运维备注\n\n**保留正文**");
        assert!(parsed.rows[0]["custom"].get("memo").is_none());
        assert_eq!(parsed.rows[1]["custom"]["memo"],"乙系统记录");
        assert!(parsed.rows[1]["custom"].get("notes").is_none());
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            let directory = std::path::PathBuf::from(directory); std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("mapping.xlsx"), bytes).unwrap();
            std::fs::write(directory.join("mapping-initial.json"), serde_json::to_vec(&initial).unwrap()).unwrap();
            std::fs::write(directory.join("mapping-applied.json"), serde_json::to_vec(&parsed).unwrap()).unwrap();
        }
    }

    #[test]
    fn export_file_names_prefix_selected_units() {
        let test = crate::vault::tests::TestVault::new("test",json!({"version":4,"units":[
            {"id":"u1","name":"大同市政府","environments":[{"id":"e1","name":"环境","zones":[{"id":"z1","name":"区域","systems":[{"id":"s1","name":"甲"}]}]}]},
            {"id":"u2","name":"单位乙/资源","environments":[{"id":"e2","name":"环境","zones":[{"id":"z2","name":"区域","systems":[{"id":"s2","name":"乙"}]}]}]}
        ],"assets":[{"id":"a1","unitId":"u1","systemId":"s1","host":"a"},{"id":"a2","unitId":"u2","systemId":"s2","host":"b"}]}));
        let mut data = crate::vault::read_unlocked(&test.state).unwrap();
        data["settings"] = json!({"exportDirectory":test.root.join("exports").to_string_lossy()}); crate::vault::save_data(&data,&test.state).unwrap();
        for (system, prefix) in [(Some("s1"),"大同市政府_资产台账-导出-"),(Some("s2"),"单位乙_资源_资产台账-导出-"),(None,"多单位_资产台账-导出-")] {
            let file = export_assets_file(system.map(str::to_owned),None,false,false,false,false,None,&test.state).unwrap();
            assert!(file.file_name.starts_with(prefix),"{}",file.file_name); assert!(file.file_name.ends_with(".xlsx"));
        }
    }

    #[test]
    fn exported_workbook_follows_ledger_column_order() {
        let fields = json!([
            {"systemId":"s","key":"host","label":"主机名","type":"text","sortOrder":0,"showInList":true},
            {"systemId":"s","key":"ip_1","label":"内网IP","type":"ip","sortOrder":1,"showInList":true},
            {"systemId":"s","key":"cpu","label":"CPU","type":"integer","sortOrder":2,"showInList":true},
            {"systemId":"s","key":"rack","label":"机架 A/B","type":"text","sortOrder":3,"showInList":true}
        ]);
        let test = crate::vault::tests::TestVault::new("test", json!({"version":4,
            "units":[{"id":"u","name":"单位","environments":[{"id":"e","name":"环境","zones":[{"id":"z","name":"区域","systems":[{"id":"s","name":"系统"}]}]}]}],
            "fieldDefs":fields,"assets":[{"id":"a","unitId":"u","environmentId":"e","zoneId":"z","systemId":"s","host":"host-a","ip":"10.31.0.1","cpu":4,"custom":{"rack":"rack-a"}}],
            "settings":{"tableColumns":[
                {"key":"field:host:text:%E4%B8%BB%E6%9C%BA%E5%90%8D","sortOrder":20,"visible":true},
                {"key":"field:ip_1:ip:%E5%86%85%E7%BD%91IP","sortOrder":10,"visible":true},
                {"key":"field:cpu:integer:CPU","sortOrder":30,"visible":true},
                {"key":"field:rack:text:%E6%9C%BA%E6%9E%B6%20A%2FB","sortOrder":0,"visible":true}
            ]}
        }));
        let mut data = crate::vault::read_unlocked(&test.state).unwrap();
        data["settings"]["exportDirectory"] = json!(test.root.join("exports").to_string_lossy());
        crate::vault::save_data(&data, &test.state).unwrap();
        for visible in [Some(vec!["host".to_owned(),"ip".to_owned(),"cpu".to_owned(),"custom:rack".to_owned()]), None] {
            let exported = export_assets_file(Some("s".to_owned()), None, false, false, false, false, visible, &test.state).unwrap();
            let bytes = std::fs::read(&exported.path).unwrap();
            let parsed = parse_import_bytes(&bytes, &HashMap::new()).unwrap();
            assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
            assert_eq!(parsed.rows[0]["ip"], "10.31.0.1");
            let mut workbook = Xlsx::new(Cursor::new(bytes.clone())).unwrap();
            let sheet = workbook.worksheet_range("环境-区域-系统").unwrap();
            let headers = sheet.rows().next().unwrap().iter().map(ToString::to_string).collect::<Vec<_>>();
            assert_eq!(&headers[..4], ["机架 A/B","内网IP","主机名","CPU"]);
            let row = sheet.rows().nth(1).unwrap();
            assert_eq!(row[..4].iter().map(ToString::to_string).collect::<Vec<_>>(), ["rack-a","10.31.0.1","host-a","4"]);
            if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
                let directory = std::path::PathBuf::from(directory); std::fs::create_dir_all(&directory).unwrap();
                let mut plain = Workbook::new();
                let worksheet = plain.add_worksheet(); worksheet.set_name("环境-区域-系统").unwrap();
                for (r, values) in sheet.rows().enumerate() {
                    for (c, value) in values.iter().enumerate() { worksheet.write_string(r as u32, c as u16, value.to_string()).unwrap(); }
                }
                let plain_bytes = plain.save_to_buffer().unwrap();
                let plain_parsed = parse_import_bytes(&plain_bytes, &HashMap::new()).unwrap();
                let mapped = parse_import_bytes(&plain_bytes, &HashMap::from([("机架 A/B".to_owned(), "rack".to_owned())])).unwrap();
                std::fs::write(directory.join("ordered-export.xlsx"), bytes).unwrap();
                std::fs::write(directory.join("ordered-without-metadata.xlsx"), plain_bytes).unwrap();
                std::fs::write(directory.join("ordered-parsed.json"), serde_json::to_vec(&parsed).unwrap()).unwrap();
                std::fs::write(directory.join("ordered-plain-parsed.json"), serde_json::to_vec(&plain_parsed).unwrap()).unwrap();
                std::fs::write(directory.join("ordered-plain-mapped.json"), serde_json::to_vec(&mapped).unwrap()).unwrap();
            }
        }
        data["settings"]["tableColumns"] = json!([]);
        let columns = ["host","ip","cpu","custom:rack"].into_iter().map(str::to_owned).collect();
        assert_eq!(&build_export_headers(&data,"s",false,Some(&columns))[..4], ["host","ip","cpu","rack"]);
    }

    #[test]
    fn disk_units_survive_import_export_round_trip() {
        let disks = parse_disks("sda|500GB; /data|1TB\nsdb|1.5TiB").unwrap();
        assert_eq!(disks, vec![json!({"label":"sda","capacity":500.0,"unit":"GB"}), json!({"label":"/data","capacity":1.0,"unit":"TB"}), json!({"label":"sdb","capacity":1.5,"unit":"TIB"})]);
        let exported = joined_disks(&json!({"disks": disks}));
        assert_eq!(parse_disks(&exported).unwrap(), disks);
        assert_eq!(joined_disks(&json!({"disks":[{"label":"/","capacity":240}]})), "/:240G");
    }

    #[test]
    fn asset_export_rejects_overlapping_operations() {
        let test = crate::vault::tests::TestVault::new("test", json!({"version": 4, "units": [], "assets": []}));
        let operation = test.state.begin_operation().unwrap();
        assert!(export_assets_file(None, None, false, false, false, false, None, &test.state).is_err());
        drop(operation);
        assert!(test.state.begin_operation().is_ok());
    }

    #[test]
    fn empty_template_preserves_columns_and_field_option_dropdowns() {
        let data = json!({"units": [
            {"id": "unit-a", "name": "单位甲", "environments": [{"id": "env-a", "name": "生产", "zones": [{"id": "zone-a", "name": "互联网区", "systems": [{"id": "sys-a", "name": "集约化"}]}]}]}
        ], "assets": [{"host": "existing-secret-host", "accounts": [{"password": "existing-secret-password"}]}]});
        let fields = vec![
            json!({"key": "host", "label": "设备编号", "sortOrder": 1}),
            json!({"key": "updated_at", "label": "修改日期", "sortOrder": 2}),
            json!({"key": "business_system", "label": "业务系统", "sortOrder": 0, "options": ["海星平台", "星辰平台"]}),
            json!({"key": "created_at", "label": "创建日期", "sortOrder": 3}),
            json!({"key": "passwordUpdatedAt", "label": "密码修改日期", "sortOrder": 4}),
            json!({"key": "password", "label": "密码", "sortOrder": 5, "templateNote": "空密码留空\n多密码换行对应账号"}),
            json!({"key": "rack", "label": "CPU", "sortOrder": 6, "options": (0..80).map(|n| format!("机柜,{n:03}")).collect::<Vec<_>>()}),
        ];
        let mut workbook = template_workbook(&data, &fields).unwrap();
        let empty_bytes = workbook.save_to_buffer().unwrap();
        let mut reader = Xlsx::new(Cursor::new(empty_bytes.clone())).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        assert_eq!(main.height(), 2);
        assert!(main.get((1, 2)).unwrap().to_string().contains("换行"));
        assert_eq!(
            main.rows()
                .next()
                .unwrap()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            ["业务系统", "设备编号", "密码", "CPU"]
        );
        let lists = reader.worksheet_range("_lists").unwrap();
        assert_eq!(lists.get((0, 0)).unwrap().to_string(), "海星平台");
        assert_eq!(lists.get((1, 0)).unwrap().to_string(), "星辰平台");
        assert_eq!(lists.get((79, 3)).unwrap().to_string(), "机柜,079");
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        worksheet.write_string(2, 0, "海星平台").unwrap();
        worksheet.write_string(2, 1, "same-host").unwrap();
        worksheet.write_string(2, 3, "机柜,000").unwrap();
        let parsed = parse_import_bytes(workbook.save_to_buffer().unwrap(), &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty());
        assert!(parsed.unmapped_headers.is_empty());
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0]["businessSystem"], "海星平台");
        assert_eq!(parsed.rows[0]["custom"]["rack"], "机柜,000");
        assert!(parsed.metadata.get("systemChoices").is_none());
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("empty-template.xlsx"), empty_bytes).unwrap();
            std::fs::write(
                directory.join("parsed.json"),
                serde_json::to_vec_pretty(&parsed).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn template_excludes_maintenance_dates_and_keeps_password_policy() {
        let fields = vec![
            json!({"key": "business_system", "label": "业务系统", "sortOrder": -1}),
            json!({"key": "name", "label": "服务器名称", "sortOrder": 0}),
            json!({"key": "updated_at", "label": "修改日期", "sortOrder": 10}),
            json!({"key": "created_at", "label": "创建日期", "sortOrder": 11}),
            json!({"key": "pwd_rotate", "label": "定期修改密码", "sortOrder": 12, "type": "boolean", "templateNote": "是/否，默认为\"否\""}),
            json!({"key": "pwd_cycle_days", "label": "密码更新周期", "sortOrder": 13, "templateNote": "定期修改密码选择\"是\"时，该处必须填写对应周期"}),
            json!({"key": "pwd_expire_at", "label": "密码更新期限", "sortOrder": 14}),
        ];
        let mut workbook = template_workbook(&json!({"units": []}), &fields).unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        let mut reader = Xlsx::new(Cursor::new(bytes)).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        let headers = main
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert_eq!(headers, ["业务系统", "服务器名称", "定期修改密码", "密码更新周期"]);
        assert_eq!(main.get((1, 2)).unwrap().to_string(), "是/否，默认为\"否\"");
        assert_eq!(main.get((1, 3)).unwrap().to_string(), "定期修改密码选择\"是\"时，该处必须填写对应周期");
    }

    #[test]
    fn template_treats_business_system_options_as_plain_values() {
        let data = json!({"units": [
            {"name": "甲", "environments": [{"name": "生产", "zones": [{"name": "互联网区", "systems": [{"id": "a", "name": "同名"}]}]}]},
            {"name": "乙", "environments": [{"name": "生产", "zones": [{"name": "互联网区", "systems": [{"id": "b", "name": "同名"}]}]}]}
        ]});
        for choice in ["missing", "同名"] {
            let fields =
                vec![json!({"key": "business_system", "label": "业务系统", "options": [choice]})];
            assert!(template_workbook(&data, &fields).is_ok());
        }
        assert!(template_workbook(&data, &[]).is_err());
    }

    #[test]
    fn displayed_headers_round_trip_with_custom_labels() {
        let data = json!({"fieldDefs": [
            {"systemId": "s", "key": "host", "label": "设备编号"},
            {"systemId": "s", "key": "rack", "label": "CPU"}
        ]});
        let keys = ["businessSystem", "host", "ip", "rack"];
        let labels = keys.map(|key| export_label(&data, "s", key));
        assert_eq!(labels, ["业务系统", "设备编号", "IP", "CPU"]);
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("业务平台").unwrap();
        for (column, label) in labels.iter().enumerate() {
            worksheet.write_string(0, column as u16, label).unwrap();
        }
        for (column, value) in ["业务平台", "server-01", "10.0.0.8", "A-01"]
            .iter()
            .enumerate()
        {
            worksheet.write_string(1, column as u16, *value).unwrap();
        }
        let metadata = workbook.add_worksheet();
        metadata.set_name("_columns").unwrap();
        for (column, key) in keys.iter().enumerate() {
            for (index, value) in [
                "业务平台".to_owned(),
                column.to_string(),
                key.to_string(),
                labels[column].clone(),
            ]
            .iter()
            .enumerate()
            {
                metadata
                    .write_string(column as u32, index as u16, value)
                    .unwrap();
            }
        }
        metadata.set_hidden(true);
        let result =
            parse_import_bytes(workbook.save_to_buffer().unwrap(), &HashMap::new()).unwrap();
        assert!(result.errors.is_empty());
        assert!(result.unmapped_headers.is_empty());
        assert_eq!(result.rows[0]["host"], "server-01");
        assert_eq!(result.rows[0]["ip"], "10.0.0.8");
        assert_eq!(result.rows[0]["businessSystem"], "业务平台");
        assert_eq!(result.rows[0]["custom"]["rack"], "A-01");
    }

    #[test]
    fn parses_export_shaped_workbook_and_reports_invalid_ip() {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.write_string(0, 0, "name").unwrap();
        worksheet.write_string(0, 1, "host").unwrap();
        worksheet.write_string(0, 2, "ip").unwrap();
        worksheet.write_string(0, 3, "disks").unwrap();
        worksheet.write_string(0, 4, "accounts").unwrap();
        worksheet.write_string(0, 5, "passwords").unwrap();
        worksheet.write_string(0, 6, "机房").unwrap();
        worksheet.write_string(1, 0, "Web 01").unwrap();
        worksheet.write_string(1, 1, "web-01").unwrap();
        worksheet.write_string(1, 2, "10.0.0.999").unwrap();
        worksheet.write_string(1, 3, "sda:500;sdb:2048").unwrap();
        worksheet.write_string(1, 4, "root;app").unwrap();
        worksheet.write_string(1, 5, "one\ntwo").unwrap();
        worksheet.write_string(1, 6, "A-01").unwrap();
        let meta = workbook.add_worksheet();
        meta.set_name("_meta").unwrap();
        meta.write_string(0, 0, "schema_version").unwrap();
        meta.write_string(0, 1, "2").unwrap();
        let bytes = workbook.save_to_buffer().unwrap();

        let result = parse_import_bytes(bytes, &HashMap::new()).unwrap();

        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0]["accounts"].as_array().unwrap().len(), 2);
        assert_eq!(result.rows[0]["disks"].as_array().unwrap().len(), 2);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].column, "ip");
        assert_eq!(result.rows[0]["custom"]["机房"], "A-01");
        assert_eq!(result.metadata["schema_version"], "2");
        assert_eq!(result.unmapped_headers, vec!["机房"]);
    }

    #[test]
    fn custom_column_mapping_recovers_missing_host_header() {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.write_string(0, 0, "设备标识").unwrap();
        worksheet.write_string(0, 1, "内网地址").unwrap();
        worksheet.write_string(1, 0, "app-01").unwrap();
        worksheet.write_string(1, 1, "10.0.0.8").unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        let mapping = HashMap::from([
            ("设备标识".to_owned(), "host".to_owned()),
            ("内网地址".to_owned(), "ip".to_owned()),
        ]);

        let result = parse_import_bytes(bytes, &mapping).unwrap();

        assert!(result.errors.is_empty());
        assert_eq!(result.rows[0]["host"], "app-01");
        assert_eq!(result.rows[0]["ip"], "10.0.0.8");
        assert_eq!(result.headers, vec!["内网地址", "设备标识"]);
    }

    #[test]
    fn raw_request_preserves_workbook_and_unicode_column_mapping() {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.write_string(0, 0, "设备标识 🖥️").unwrap();
        worksheet.write_string(0, 1, "内网地址").unwrap();
        worksheet.write_string(1, 0, "app-01").unwrap();
        worksheet.write_string(1, 1, "10.0.0.8").unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        let mapping = HashMap::from([("设备标识 🖥️".to_owned(), "host".to_owned()), ("内网地址".to_owned(), "ip".to_owned())]);
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("x-column-mapping", r#"{"\u8bbe\u5907\u6807\u8bc6 \ud83d\udda5\ufe0f":"host","\u5185\u7f51\u5730\u5740":"ip"}"#.parse().unwrap());
        let expected = parse_import_bytes(&bytes, &mapping).unwrap();
        let json_body = tauri::ipc::InvokeBody::Json(serde_json::to_value(&bytes).unwrap());
        let body = tauri::ipc::InvokeBody::Raw(bytes);
        let actual = parse_import_request(&body, &headers).unwrap();
        assert_eq!(serde_json::to_value(&actual).unwrap(), serde_json::to_value(expected).unwrap());
        assert_eq!(serde_json::to_value(parse_import_request(&json_body, &headers).unwrap()).unwrap(), serde_json::to_value(actual).unwrap());
        for invalid in [json!([-1]), json!([1.5]), json!([1.0]), json!([256]), json!([null]), json!([true]), json!(["1"])] {
            assert!(parse_import_request(&tauri::ipc::InvokeBody::Json(invalid), &headers).unwrap_err().contains("传输字节无效"));
        }
        for invalid in ["null", "{", r#"{"host": 1}"#] {
            headers.insert("x-column-mapping", invalid.parse().unwrap());
            assert!(parse_import_request(&body, &headers).unwrap_err().contains("列映射格式无效"));
        }
        headers.clear();
        assert!(parse_import_request(&body, &headers).is_ok());
        assert!(parse_import_request(&tauri::ipc::InvokeBody::Json(json!({"bytes": [1, 2]})), &headers).unwrap_err().contains("传输格式无效"));
        assert!(parse_import_request(&tauri::ipc::InvokeBody::Raw(vec![1, 2, 3]), &headers).is_err());
    }

    #[test]
    fn template_import_reports_actual_excel_rows() {
        let fields = vec![
            json!({"key": "host", "label": "主机名"}),
            json!({"key": "ip_1", "label": "IP"}),
        ];
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        worksheet.write_string(2, 0, "server-01").unwrap();
        worksheet.write_string(2, 1, "invalid-ip").unwrap();
        worksheet.write_string(4, 0, "server-02").unwrap();
        let result = parse_import_bytes(workbook.save_to_buffer().unwrap(), &HashMap::new()).unwrap();
        assert_eq!(result.rows[0]["rowNumber"], 3);
        assert_eq!(result.errors[0].row_number, 3);
        assert_eq!(result.rows[1]["rowNumber"], 5);
    }

    #[test]
    fn business_system_manual_mapping_keeps_asset_value() {
        for field_key in ["business_system", "businessSystem"] {
            let mut workbook = Workbook::new();
            let worksheet = workbook.add_worksheet();
            worksheet.write_string(0, 0, "子系统").unwrap();
            worksheet.write_string(0, 1, "主机名").unwrap();
            worksheet.write_string(1, 0, "海星平台").unwrap();
            worksheet.write_string(1, 1, "server-01").unwrap();
            let mapping = HashMap::from([("子系统".to_owned(), field_key.to_owned())]);
            let result = parse_import_bytes(workbook.save_to_buffer().unwrap(), &mapping).unwrap();
            assert_eq!(result.rows[0]["businessSystem"], "海星平台");
            assert_eq!(result.rows[0]["system"], "");
            assert!(result.rows[0]["custom"].as_object().unwrap().is_empty());
            assert_eq!(result.rows[0]["rowNumber"], 2);
        }
    }

    #[test]
    fn audit_export_preserves_values_and_asset_history_can_hide_them() {
        for field_key in ["accounts", "password", "custom"] {
            let item = json!({"fieldKey": field_key, "before": {"password": "secret"}});
            assert_eq!(audit_value(&item, "before", false), "[敏感字段已隐藏]");
            assert_eq!(audit_value(&item, "before", true), r#"{"password":"secret"}"#);
        }
        let item = json!({"fieldKey": "accounts", "after": [{"username": "root", "password": "new-secret"}]});
        assert_eq!(audit_value(&item, "after", true), r#"[{"password":"new-secret","username":"root"}]"#);
        let item = json!({"fieldKey": "password", "before": "old-secret", "after": ""});
        assert_eq!(audit_value(&item, "before", true), "old-secret");
        assert_eq!(audit_value(&item, "after", true), "");
        let item = json!({"fieldKey": "host", "after": "web-01"});
        assert_eq!(audit_value(&item, "after", true), "web-01");
    }

    #[test]
    fn account_import_keeps_blank_password_positions() {
        let accounts = parse_accounts("root;app", "\napp-secret", "\n2026-09-30").unwrap();
        assert_eq!(accounts[0]["password"], "");
        assert_eq!(accounts[1]["password"], "app-secret");
        assert_eq!(accounts[0]["passwordUpdatedAt"], "");
        assert_eq!(accounts[1]["passwordUpdatedAt"], "2026-09-30");
        let accounts = parse_accounts("root;app", "[\"root;secret\",\"app-secret\"]", "").unwrap();
        let blank = parse_accounts("", "", "").unwrap();
        assert_eq!(blank[0]["username"], "root");
        assert_eq!(accounts[0]["password"], "root;secret");
        assert_eq!(accounts[1]["password"], "app-secret");
    }

    #[test]
    fn template_instructions_use_field_configuration() {
        let fields = vec![
            json!({"key": "host", "label": "主机名", "required": true, "templateNote": "必填\n系统内唯一"}),
            json!({"key": "cpu", "label": "CPU", "type": "integer"}),
            json!({"key": "rack", "label": "机柜", "required": true, "type": "text"}),
            json!({"key": "business_system", "label": "业务系统", "options": ["平台甲", "平台乙"]}),
            json!({"key": "name", "label": "服务器名称"}),
            json!({"key": "ip_1", "label": "IP", "type": "ip"}),
            json!({"key": "mem", "label": "内存", "type": "integer"}),
            json!({"key": "os", "label": "操作系统版本"}),
            json!({"key": "asset_tag", "label": "标签", "type": "text"}),
        ];
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        let mut reader = Xlsx::new(Cursor::new(workbook.save_to_buffer().unwrap())).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        assert_eq!(main.get((1, 0)).unwrap().to_string(), "必填\n系统内唯一");
        assert_eq!(main.get((1, 1)).unwrap().to_string(), "/");
        assert_eq!(main.get((1, 2)).unwrap().to_string(), "/");
        for column in 3..8 {
            assert_eq!(main.get((1, column)).unwrap().to_string(), "/");
        }
        for note in main.rows().nth(1).unwrap() {
            assert!(!note.to_string().contains("选填"));
        }
    }

    #[test]
    fn template_ip_labels_and_configured_notes_round_trip() {
        let mut fields = vec![
            json!({"key": "host", "label": "设备编号", "type": "text", "templateNote": "/"}),
            json!({"key": "ip_1", "label": "IP_1", "type": "ip", "templateNote": "/"}),
            json!({"key": "ip_2", "label": "IP_2", "type": "ip", "templateNote": "填写“备用地址”\r\n第二行"}),
        ];
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        for (column, value) in ["ip-label-01", "172.16.0.1", "172.16.0.2"].iter().enumerate() {
            worksheet.write_string(2, column as u16, *value).unwrap();
        }
        let bytes = workbook.save_to_buffer().unwrap();
        let mut reader = Xlsx::new(Cursor::new(bytes.clone())).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        assert_eq!(main.rows().next().unwrap().iter().map(ToString::to_string).collect::<Vec<_>>(), ["设备编号", "IP_1", "IP_2"]);
        assert_eq!(main.get((1, 2)).unwrap().to_string(), "填写\"备用地址\"\n第二行");
        let parsed = parse_import_bytes(bytes.clone(), &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.rows[0]["ip"], "172.16.0.1");
        assert_eq!(parsed.rows[0]["ip2"], "172.16.0.2");

        fields[2]["templateNote"] = json!("");
        let mut cleared = template_workbook(&json!({}), &fields).unwrap();
        let cleared_bytes = cleared.save_to_buffer().unwrap();
        let mut cleared_reader = Xlsx::new(Cursor::new(cleared_bytes.clone())).unwrap();
        assert_eq!(cleared_reader.worksheet_range("资产导入").unwrap().get((1, 2)).unwrap().to_string(), "/");
        fields[2].as_object_mut().unwrap().remove("templateNote");
        let mut unset = template_workbook(&json!({}), &fields).unwrap();
        let mut unset_reader = Xlsx::new(Cursor::new(unset.save_to_buffer().unwrap())).unwrap();
        assert_eq!(unset_reader.worksheet_range("资产导入").unwrap().get((1, 2)).unwrap().to_string(), "/");
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::write(directory.join("configured-ip-template.xlsx"), bytes).unwrap();
            std::fs::write(directory.join("cleared-ip-template.xlsx"), cleared_bytes).unwrap();
        }
    }

    #[test]
    fn template_follows_field_order_in_headers_mapping_and_import() {
        let fields = vec![
            json!({"key": "host", "label": "设备编号", "sortOrder": 2}),
            json!({"key": "cpu", "label": "CPU", "sortOrder": 4}),
            json!({"key": "status", "label": "状态", "sortOrder": 0, "systemField": true}),
            json!({"key": "created_at", "label": "创建日期", "sortOrder": -1}),
            json!({"key": "rack", "label": "机柜", "sortOrder": 1}),
            json!({"key": "business_system", "label": "业务系统", "sortOrder": 3}),
        ];
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        let empty_bytes = workbook.save_to_buffer().unwrap();
        let mut reader = Xlsx::new(Cursor::new(empty_bytes.clone())).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        assert_eq!(main.rows().next().unwrap().iter().map(ToString::to_string).collect::<Vec<_>>(),
            ["状态", "机柜", "设备编号", "业务系统", "CPU"]);
        let mapping = reader.worksheet_range("_columns").unwrap();
        assert_eq!(mapping.rows().map(|row| row[2].to_string()).collect::<Vec<_>>(),
            ["status", "rack", "host", "businessSystem", "cpu"]);
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        for (column, value) in ["测试", "A-01", "ordered-01", "业务平台", "8"].iter().enumerate() {
            worksheet.write_string(2, column as u16, *value).unwrap();
        }
        let parsed = parse_import_bytes(workbook.save_to_buffer().unwrap(), &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.rows[0]["host"], "ordered-01");
        assert_eq!(parsed.rows[0]["custom"]["rack"], "A-01");
        assert_eq!(parsed.rows[0]["businessSystem"], "业务平台");
        assert_eq!(parsed.rows[0]["cpu"], 8.0);
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            std::fs::write(std::path::PathBuf::from(directory).join("reordered-template.xlsx"), empty_bytes).unwrap();
        }
    }

    #[test]
    fn template_notes_markdown_and_custom_label_round_trip() {
        let fields = vec![
            json!({"key": "host", "label": "设备编号", "sortOrder": 0}),
            json!({"key": "notes", "label": "服务与目录", "type": "textarea", "sortOrder": 1, "validation": {"maxLength": 500}, "templateNote": "/"}),
            json!({"key": "created_at", "label": "创建日期", "sortOrder": 2}),
            json!({"key": "updated_at", "label": "修改日期", "sortOrder": 3}),
            json!({"key": "passwordUpdatedAt", "label": "密码修改日期", "sortOrder": 4}),
            json!({"key": "pwd_expire_at", "label": "密码更新期限", "sortOrder": 5}),
        ];
        let notes = "# 服务与目录\n\n- **Nginx**：/etc/nginx\n- 日志：C:\\AssetOps\\logs\n\n> 切换前备份\n\n```sh\nsystemctl status nginx\n```\n\n[说明](https://example.com/service)";
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        let mut reader = Xlsx::new(Cursor::new(workbook.save_to_buffer().unwrap())).unwrap();
        let main = reader.worksheet_range("资产导入").unwrap();
        assert_eq!(main.height(), 2);
        assert_eq!(main.rows().next().unwrap().iter().map(ToString::to_string).collect::<Vec<_>>(), ["设备编号", "服务与目录"]);
        assert_eq!(main.get((1, 1)).unwrap().to_string(), "/");
        let mapping = reader.worksheet_range("_columns").unwrap();
        assert_eq!(mapping.rows().map(|row| row[2].to_string()).collect::<Vec<_>>(), ["host", "notes"]);
        assert_eq!(mapping.get((1, 3)).unwrap().to_string(), "服务与目录");
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        worksheet.write_string(2, 0, "notes-01").unwrap();
        worksheet.write_string(2, 1, notes).unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        let mut filled = Xlsx::new(Cursor::new(bytes.clone())).unwrap();
        assert_eq!(filled.worksheet_range("资产导入").unwrap().get((2, 1)).unwrap().to_string(), notes);
        let parsed = parse_import_bytes(bytes.clone(), &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty());
        assert!(parsed.unmapped_headers.is_empty());
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0]["host"], "notes-01");
        assert_eq!(parsed.rows[0]["rowNumber"], 3);
        assert_eq!(parsed.rows[0]["custom"]["notes"], notes);
        assert!(parsed.rows[0]["custom"].get("服务与目录").is_none());
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("notes-template.xlsx"), bytes).unwrap();
            std::fs::write(directory.join("parsed-notes.json"), serde_json::to_vec_pretty(&parsed).unwrap()).unwrap();
        }
    }

    #[test]
    fn default_template_and_multiline_entries_round_trip() {
        let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") else { return; };
        let directory = std::path::PathBuf::from(directory);
        let fields: Vec<serde_json::Value> = serde_json::from_slice(
            &std::fs::read(directory.join("template-fields.json")).unwrap(),
        ).unwrap();
        let mut workbook = template_workbook(&json!({}), &fields).unwrap();
        std::fs::write(directory.join("default-template.xlsx"), workbook.save_to_buffer().unwrap()).unwrap();
        let mut reader = Xlsx::new(Cursor::new(workbook.save_to_buffer().unwrap())).unwrap();
        let headers = reader.worksheet_range("_columns").unwrap();
        let columns: HashMap<String, u16> = headers.rows().map(|row| (
            row[2].to_string(), row[1].to_string().parse().unwrap(),
        )).collect();
        let worksheet = workbook.worksheet_from_name("资产导入").unwrap();
        for (key, value) in [
            ("businessSystem", "示例平台"), ("name", "测试服务器"), ("host", "template-01"),
            ("ip", "10.0.0.8"), ("status", "测试"), ("cpu", "8"), ("memory", "32"),
            ("disks", "sda|200\nsdb|500"), ("os", "Linux"), ("accounts", "root\napp"),
            ("passwords", "000123\napp;secret"), ("rotatePassword", "是"), ("passwordCycleDays", "90"),
            ("notes", "## 服务\n- nginx：/etc/nginx\n- 日志：/var/log/nginx"),
        ] {
            worksheet.write_string(2, columns[key], value).unwrap();
        }
        worksheet.write_string(250, columns["host"], "template-02").unwrap();
        worksheet.write_string(250, columns["disks"], "sdc|100\nsdd|200").unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        std::fs::write(directory.join("multiline-template.xlsx"), &bytes).unwrap();
        let parsed = parse_import_bytes(bytes, &HashMap::new()).unwrap();
        std::fs::write(directory.join("parsed-template.json"), serde_json::to_vec_pretty(&parsed).unwrap()).unwrap();
        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.rows[0]["rowNumber"], 3);
        assert_eq!(parsed.rows[1]["rowNumber"], 251);
        assert_eq!(parsed.rows[0]["disks"][1]["label"], "sdb");
        assert_eq!(parsed.rows[0]["accounts"][0]["password"], "000123");
        assert_eq!(parsed.rows[0]["accounts"][1]["password"], "app;secret");
        assert_eq!(parsed.rows[0]["custom"]["notes"], "## 服务\n- nginx：/etc/nginx\n- 日志：/var/log/nginx");
    }

    #[test]
    fn default_account_preserves_password_and_windows_newlines_align() {
        let account = parse_accounts("", "000123", "").unwrap();
        assert_eq!(account[0]["username"], "root");
        assert_eq!(account[0]["password"], "000123");
        for (users, passwords) in [
            ("root\r\napp", "root-secret\napp-secret"),
            ("root\napp", "root-secret\r\napp-secret"),
        ] {
            let accounts = parse_accounts(users, passwords, "").unwrap();
            assert_eq!(accounts[1]["password"], "app-secret");
        }
    }

    #[test]
    fn report_csv_cells_do_not_start_formulas() {
        assert_eq!(csv_cell("=1+1"), "\"'=1+1\"");
        assert_eq!(csv_cell("normal,\"text"), "\"normal,\"\"text\"");
    }

    #[test]
    fn sheet_names_match_excel_rules() {
        let names = ["_meta", "字段说明", "变更历史", " /:*?[]\\ ", " '环境-区域-系统' ", "'''", "Mixed", "MIXED"]
            .into_iter().map(str::to_owned).chain([format!("{}甲", "长".repeat(31)), format!("{}乙", "长".repeat(31))]).collect::<Vec<_>>();
        let mut used = ["_meta", "_columns", "_systems", "_lists", "字段说明", "变更历史"].into_iter().map(str::to_owned).collect::<std::collections::HashSet<_>>();
        let results = names.iter().map(|name| sheet_name(name, &mut used)).collect::<Vec<_>>();
        let mut workbook = Workbook::new();
        for name in &results { workbook.add_worksheet().set_name(name).unwrap(); }
        assert_eq!(results[4], "环境-区域-系统");
        assert_eq!(results[7], "MIXED-2");
        assert!(results.iter().all(|name| name.chars().count() <= 31));
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            std::fs::write(std::path::Path::new(&directory).join("export-sheet-names.json"), serde_json::to_vec(&json!({ "names": names, "results": results })).unwrap()).unwrap();
        }
    }

    #[test]
    fn export_dates_and_widths_preserve_single_lines() {
        assert_eq!(export_datetime("2026-10-05"), "2026-10-05 00:00:00");
        assert_eq!(export_datetime("2026-10-05 12:34:56"), "2026-10-05 12:34:56");
        let timestamp = "2026-10-05T04:34:56.789Z";
        let expected = chrono::DateTime::parse_from_rfc3339(timestamp).unwrap().with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string();
        assert_eq!(export_datetime(timestamp), expected);
        assert_eq!(export_datetime(""), "");
        assert_eq!(export_datetime("legacy-value"), "legacy-value");
        let chinese = "集约化平台数据库备份服务器";
        assert!(export_cell_width(chinese) > chinese.chars().count() as u32 * 16);
        assert_eq!(export_cell_width("root\napplication-user"), export_cell_width("application-user"));
        assert_eq!(export_cell_width("root\r\napplication-user"), export_cell_width("application-user"));
        assert_eq!(export_cell_width(&"服".repeat(500)), 1790);
    }

    #[test]
    fn export_uses_structure_names_and_one_status_column() {
        let mut fields = ["s1", "s2"].into_iter().map(|system| json!({
            "id": format!("status-{system}"), "systemId": system, "key": "status", "label": "服务器状态",
        })).collect::<Vec<_>>();
        fields.extend(["s1", "s2"].into_iter().map(|system| json!({
            "id": format!("notes-{system}"), "systemId": system, "key": "notes", "label": "备注", "type": "textarea",
        })));
        let assets = [("a1", "s1", "z1", "生产"), ("a2", "s2", "z2", "测试")].into_iter().map(|(id, system, zone, status)| json!({
            "id": id, "unitId": "u", "environmentId": "e", "zoneId": zone, "systemId": system,
            "name": "集约化平台数据库备份服务器", "host": id, "status": status, "cpu": null, "memory": null,
            "os": "CentOS Linux release 7.9.2009 (Core)",
            "createdAt": "2026-10-02T04:34:56.789Z", "updatedAt": "2026-10-03 12:34:56",
            "accounts": [{"username": "root", "password": "000123", "passwordUpdatedAt": "2026-09-30"}],
            "custom": {"notes": "应用目录 /opt/app\n日志目录 /var/log/app"},
        })).collect::<Vec<_>>();
        let test = crate::vault::tests::TestVault::new("test", json!({
            "version": 4, "units": [{"id": "u", "name": "单位", "environments": [{"id": "e", "name": "生产环境", "zones": [
                {"id": "z1", "name": "互联网区", "systems": [{"id": "s1", "name": "同名系统"}]},
                {"id": "z2", "name": "内网区", "systems": [{"id": "s2", "name": "同名系统"}]},
            ]}]}], "assets": assets, "fieldDefs": fields,
            "history": [{"id": "h1", "assetId": "a1", "systemId": "s1", "objectName": "服务器", "items": [{"fieldKey": "notes", "before": "", "after": "目录\n服务"}]}],
        }));
        let mut fixture = crate::vault::read_unlocked(&test.state).unwrap();
        fixture["settings"] = json!({"exportDirectory": test.root.join("exports").to_string_lossy()});
        crate::vault::save_data(&fixture, &test.state).unwrap();
        let exported = export_assets_file(None, None, false, true, false, false, None, &test.state).unwrap();
        let bytes = std::fs::read(&exported.path).unwrap();
        if let Some(directory) = std::env::var_os("ASSETOPS_VERIFY_DIR") {
            std::fs::write(std::path::Path::new(&directory).join("assets-export.xlsx"), &bytes).unwrap();
            let with_sheets = export_assets_file(None, None, false, true, true, true, None, &test.state).unwrap();
            std::fs::copy(with_sheets.path, std::path::Path::new(&directory).join("assets-export-with-sheets.xlsx")).unwrap();
        }
        let mut workbook = Xlsx::new(Cursor::new(bytes.clone())).unwrap();
        for (name, status) in [("生产环境-互联网区-同名系统", "生产"), ("生产环境-内网区-同名系统", "测试")] {
            let sheet = workbook.worksheet_range(name).unwrap();
            let headers = sheet.rows().next().unwrap().iter().map(ToString::to_string).collect::<Vec<_>>();
            assert_eq!(headers.iter().filter(|label| label.as_str() == "服务器状态").count(), 1);
            let column = headers.iter().position(|label| label == "服务器状态").unwrap();
            assert_eq!(sheet.rows().nth(1).unwrap()[column].to_string(), status);
            let row = sheet.rows().nth(1).unwrap();
            let password_date = headers.iter().position(|label| label == "密码修改日期").unwrap();
            assert_eq!(row[password_date].to_string(), "2026-09-30 00:00:00");
            let updated_date = headers.iter().position(|label| label == "修改日期").unwrap();
            assert_eq!(row[updated_date].to_string(), "2026-10-03 12:34:56");
        }
        let parsed = parse_import_bytes(bytes, &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert_eq!(parsed.rows.len(), 2);
        for row in parsed.rows {
            assert_eq!(row["accounts"][0]["password"], "000123");
            let expected = if row["host"] == "a1" { ("s1", "互联网区", "生产") } else { ("s2", "内网区", "测试") };
            let system = parsed.metadata["systems"].as_array().unwrap().iter().find(|system| system["sheetName"] == row["sheet"]).unwrap();
            assert_eq!(system["systemId"], expected.0);
            assert_eq!(row["environment"], "生产环境");
            assert_eq!(row["zone"], expected.1);
            assert_eq!(row["status"], expected.2);
        }
        let one_system = export_assets_file(Some("s2".to_owned()), None, false, false, false, false, None, &test.state).unwrap();
        assert_eq!(one_system.rows, 1);
        let one_asset = export_assets_file(None, Some(vec!["a1".to_owned()]), false, false, false, false, None, &test.state).unwrap();
        let selected = parse_import_bytes(std::fs::read(one_asset.path).unwrap(), &HashMap::new()).unwrap();
        assert_eq!(selected.rows.len(), 1);
        assert_eq!(selected.rows[0]["host"], "a1");
    }

    #[test]
    fn password_whitespace_and_reserved_sheet_names_round_trip() {
        let names = ["_审查系统".to_owned(), "字段说明".to_owned(), "变更历史".to_owned(), "_meta".to_owned(), format!("{}甲", "长".repeat(31)), format!("{}乙", "长".repeat(31)), "Mixed".to_owned(), "MIXED".to_owned()];
        let systems = names.iter().enumerate().map(|(index, name)| json!({"id": format!("s{index}"), "name": name})).collect::<Vec<_>>();
        let assets = systems.iter().enumerate().map(|(index, system)| json!({
            "id": format!("a{index}"), "systemId": system["id"], "name": "测试服务器", "host": format!("node-{index}"),
            "accounts": if index == 0 { json!([{"username": "root", "password": "  secret;value  \nline "}]) } else if index == 1 { json!([{"username": "root", "password": "[\"literal\",\"password\"]"}]) } else { json!([{"username": "root", "password": "  first  "}, {"username": "app", "password": " second;\nvalue "}]) },
            "cpu": null, "memory": null
        })).collect::<Vec<_>>();
        let test = crate::vault::tests::TestVault::new("test", json!({"version": 4, "units": [{"id": "u", "name": "单位", "environments": [{"id": "e", "name": "环境", "zones": [{"id": "z", "name": "区域", "systems": systems}]}]}], "assets": assets}));
        let mut fixture = crate::vault::read_unlocked(&test.state).unwrap();
        fixture["settings"] = json!({"exportDirectory": test.root.join("exports").to_string_lossy()});
        crate::vault::save_data(&fixture, &test.state).unwrap();
        let exported = export_assets_file(None, None, false, true, true, true, None, &test.state).unwrap();
        let parsed = parse_import_bytes(std::fs::read(exported.path).unwrap(), &HashMap::new()).unwrap();
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert_eq!(parsed.rows.len(), names.len());
        for row in &parsed.rows {
            if row["host"] == "node-0" { assert_eq!(row["accounts"][0]["password"], "  secret;value  \nline "); }
            else if row["host"] == "node-1" { assert_eq!(row["accounts"][0]["password"], "[\"literal\",\"password\"]"); }
            else {
                assert_eq!(row["accounts"][0]["password"], "  first  ");
                assert_eq!(row["accounts"][1]["password"], " second;\nvalue ");
            }
            assert!(row["cpu"].is_null());
            assert!(row["memory"].is_null());
        }
        assert_eq!(parsed.metadata["systems"].as_array().unwrap().len(), names.len());
    }

    #[test]
    fn external_underscore_sheets_and_plain_passwords_are_preserved() {
        let mut workbook = Workbook::new();
        for name in ["_测试系统", "字段说明", "_meta"] {
            let sheet = workbook.add_worksheet();
            sheet.set_name(name).unwrap();
            sheet.write_string(0, 0, "主机名").unwrap();
            sheet.write_string(0, 1, "密码").unwrap();
            sheet.write_string(1, 0, name).unwrap();
            sheet.write_string(1, 1, "  preserved  ").unwrap();
        }
        let parsed = parse_import_bytes(workbook.save_to_buffer().unwrap(), &HashMap::new()).unwrap();
        assert_eq!(parsed.rows.len(), 3);
        for row in parsed.rows { assert_eq!(row["accounts"][0]["password"], "  preserved  "); }
        assert!(parsed.errors.is_empty());
        let aligned = parse_accounts("root\r\napp", "  first  \r\n second  ", "").unwrap();
        assert_eq!(aligned[0]["password"], "  first  ");
        assert_eq!(aligned[1]["password"], " second  ");
    }
    #[test]
    fn audit_workbook_masks_passwords_unless_explicitly_requested() {
        let test = crate::vault::tests::TestVault::new("fixture", json!({"assets":[],"history":[{"id":"audit-private","items":[{"fieldKey":"accounts","before":[{"username":"root","password":"audit-private-before"}],"after":[{"username":"root","password":"audit-private-after"}]}]}]}));
        let mut data = crate::vault::read_unlocked(&test.state).unwrap(); data["settings"] = json!({"exportDirectory":test.root.join("exports").to_string_lossy()}); crate::vault::save_unlocked(&data, &test.state).unwrap();
        for include in [false, true] {
            let file = super::export_audit_file(&test.state, include).unwrap();
            let mut workbook = Xlsx::new(Cursor::new(std::fs::read(file.path).unwrap())).unwrap();
            let sheet = workbook.worksheet_range_at(0).unwrap().unwrap();
            let all = sheet.rows().flatten().map(ToString::to_string).collect::<Vec<_>>().join(" ");
            assert_eq!(all.contains("audit-private-before"), include); assert_eq!(all.contains("audit-private-after"), include);
        }
    }
    #[test]
    fn import_resource_limits_reject_oversized_and_expanding_files() {
        assert!(super::validate_import_size(&vec![0; super::MAX_IMPORT_BYTES + 1]).unwrap_err().contains("64 MB"));
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new())); zip.start_file("xl/worksheets/sheet1.xml", zip::write::SimpleFileOptions::default()).unwrap();
        let mut bytes = zip.finish().unwrap().into_inner(); let central = bytes.windows(4).position(|part| part == b"PK\x01\x02").unwrap(); bytes[central + 24..central + 28].copy_from_slice(&(300_u32 * 1024 * 1024).to_le_bytes());
        assert!(super::validate_import_size(&bytes).unwrap_err().contains("256 MB"));
    }
    #[test]
    fn account_alignment_rejects_mismatched_values() {
        for value in ["secret", "one;two", "one\ntwo\nthree", "[\"one\"]"] { assert!(parse_accounts("root;app", value, "").unwrap_err().contains("数量不一致")); }
        assert!(parse_accounts("root;app", "one\ntwo", "a;b;c").is_err());
        assert_eq!(parse_accounts("root;app", "\napp-secret", "").unwrap()[1]["password"], "app-secret");
    }
    #[test]
    fn csv_controls_cannot_start_a_formula() {
        for value in ["\t=1+1", "\r@SUM(A1)", "\tordinary", "\rordinary"] { assert!(csv_cell(value).starts_with("\"'")); }
    }
    #[test]
    fn reveal_path_requires_a_canonical_allowed_directory() {
        let test = crate::vault::tests::TestVault::new("test", json!({"assets":[]})); let allowed = test.root.join("exports"); std::fs::create_dir(&allowed).unwrap();
        let inside = allowed.join("export.xlsx"); std::fs::write(&inside, b"test").unwrap(); let outside = test.root.join("private.txt"); std::fs::write(&outside, b"test").unwrap();
        assert!(super::allowed_reveal_path(&inside, &[allowed.clone()]).is_ok()); assert!(super::allowed_reveal_path(&outside, &[allowed.clone()]).is_err()); assert!(super::allowed_reveal_path(&allowed.join("../private.txt"), &[allowed]).is_err());
    }
}
