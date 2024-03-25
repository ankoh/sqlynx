use tauri::AppHandle;

pub fn process_deep_link(event: tauri::Event, _handle: AppHandle) {
    let payload = event.payload();
    let Some(link) = payload.get(2..payload.len() - 2) else {
        return;
    };

    if link.starts_with("sqlynx://") {
        log::info!("received deep link: {}", link);
    } else {
        log::info!("unknown deep link: {}", link);
    }
}
