pub(crate) fn require_main(label: &str) -> Result<(), String> {
    if label == "main" { Ok(()) } else { Err("此窗口无权执行数据命令".into()) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_main_window_can_run_sensitive_commands() {
        assert!(super::require_main("main").is_ok());
        for label in ["search", "", "main-copy", "external"] { assert!(super::require_main(label).is_err()); }
    }
}
