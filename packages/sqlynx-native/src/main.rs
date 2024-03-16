// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod grpc_client;
mod grpc_proxy;
mod grpc_proxy_globals;
mod grpc_proxy_router;
mod grpc_stream_manager;
mod ipc_router;
mod proto;
#[cfg(test)]
mod test;
mod status;

use ipc_router::process_ipc_request;
use tauri::AppHandle;
use std::env;

#[tokio::main]
async fn main() {
    // Setup the logger
    if env::var("RUST_LOG").is_err() {
        env::set_var("RUST_LOG", "info")
    }
    env_logger::init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![sqlynx_get_os])
        .register_asynchronous_uri_scheme_protocol(
            "sqlynx-native",
            move |_runtime, request, responder| {
                tokio::spawn(async move {
                    let response = process_ipc_request(request).await;
                    responder.respond(response);
                });
            },
        )
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(desktop)]
            handle.plugin(tauri_plugin_updater::Builder::new().build())?;

            // Forward deep-link events
            app.listen("deep-link://new-url", move |event| deep_link(event, handle.clone()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sqlynx_get_os() -> &'static str {
    return "darwin";
}


fn deep_link(event: tauri::Event, _handle: AppHandle) {
    let payload = event.payload();
    let Some(link) = payload.get(2..payload.len() - 2) else {
        return;
    };

    if link.starts_with("sqlynx://") {
        println!("received deep link: {}", link);
    } else {
        println!("unknown deep link: {}", link);
    }
}
