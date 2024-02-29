// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod grpc_proxy;
mod grpc_stream_manager;
#[cfg(test)]
mod hyper_service_mocks;
mod ipc_router;
mod proto;

use ipc_router::route_ipc_request;
use std::env;

fn main() {
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
                    let response = route_ipc_request(request).await;
                    responder.respond(response);
                });
            },
        )
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sqlynx_get_os() -> &'static str {
    return "darwin";
}
