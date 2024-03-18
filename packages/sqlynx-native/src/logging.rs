
#[cfg(debug_assertions)]
pub mod config {
    use log::LevelFilter;
    use tauri_plugin_log::Target as LogTarget;
    use tauri_plugin_log::TargetKind as LogTargetKind;

    pub const LOG_TARGETS: [LogTarget; 2] = [LogTarget::new(LogTargetKind::Stdout), LogTarget::new(LogTargetKind::Webview)];
    pub const LOG_LEVEL: LevelFilter = LevelFilter::Trace;
}

#[cfg(not(debug_assertions))]
pub mod config {
    use log::LevelFilter;
    use tauri_plugin_log::Target as LogTarget;
    use tauri_plugin_log::TargetKind as LogTargetKind;

    pub const LOG_TARGETS: [LogTarget; 2] = [LogTarget::new(LogTargetKind::Stdout), LogTarget::new(LogTargetKind::LogDir { file_name: None })];
    pub const LOG_LEVEL: LevelFilter = LevelFilter::Info;
}
