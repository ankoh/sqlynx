use lazy_static::lazy_static;
use tauri::AppHandle;
use regex_automata::util::captures::Captures;
use regex_automata::meta::Regex;

lazy_static! {
    static ref ROUTES: Regex = Regex::new_many(&[
        r"^sqlynx://localhost/oauth$",
    ]).unwrap();
}

pub fn process_deep_link(event: tauri::Event, _handle: AppHandle) {
    let payload = event.payload();
    let Some(link) = payload.get(2..payload.len() - 2) else {
        return;
    };

    let mut all = Captures::all(ROUTES.group_info().clone());
    ROUTES.captures(link, &mut all);

    match all.pattern().map(|p| p.as_usize()) {
        Some(0) => {
            log::info!("received deep link: {}", link);
        }
        _ => {
            log::info!("unknown deep link: {}", link);
        }
    }
}
