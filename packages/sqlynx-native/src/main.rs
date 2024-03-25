// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deep_link;
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
mod logging;

use ipc_router::process_ipc_request;
use tauri::AppHandle;

#[tokio::main]
async fn main() {
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
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets(logging::config::LOG_TARGETS)
                .level(logging::config::LOG_LEVEL)
                .build()
        )
        .setup(|app| {
            let handle = app.handle().clone();

            // Only setup the updater plugin for Desktop builds
            #[cfg(desktop)]
            handle.plugin(tauri_plugin_updater::Builder::new().build())?;

            // Forward all deep-link events to a custom handler
            app.listen("deep-link://new-url", move |event| deep_link::process_deep_link(event, handle.clone()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sqlynx_get_os() -> &'static str {
    return "darwin";
}
