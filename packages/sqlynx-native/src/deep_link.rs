use tauri::{AppHandle, Manager};
use url::Url;
use std::borrow::Cow;

pub fn process_deep_link(event: tauri::Event, handle: AppHandle) {
    let payload = event.payload();
    let Some(link) = payload.get(2..payload.len() - 2) else {
        return;
    };
    // Parse deep link
    log::trace!("received deep link");
    let link_parsed = match Url::parse(link) {
        Ok(url) => url,
        Err(e) => {
            log::warn!("failed to parse deep link: {}", e);
            return;
        },
    };
    // Check scheme of deep link
    if link_parsed.scheme() != "sqlynx" {
        log::warn!("received deep link with unknown scheme `{}`", link_parsed.scheme());
        return;
    }
    // Unpack query parameters
    let mut event_data = None;
    for (k, v) in link_parsed.query_pairs() {
        match k {
            Cow::Borrowed("event") => {
                event_data = Some(v);
            }
            k => {
                log::warn!("unknown deep link parameter `{}`", k);
            }
        }
    }
    // Did we receive event data?
    let event_data = if let Some(event_data) = event_data {
        event_data
    } else {
        log::warn!("deep link misses parameter `event`");
        return;
    };
    log::trace!("emitting app event from deep link");

    // Forward the event to the PWA
    match handle.emit("sqlynx:event", event_data.to_string()) {
        Ok(_) => {},
        Err(e) => {
            log::error!("failed to emit app event for deep link: {}", e);
        }
    };
}
