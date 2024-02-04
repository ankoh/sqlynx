// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE};
use tauri::http::response::Builder as ResponseBuilder;
use tauri::http::Request;
use tauri::http::Response;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![sqlynx_get_os])
        .register_asynchronous_uri_scheme_protocol(
            "sqlynx-ipc",
            move |_runtime, request, responder| {
                let response = sqlynx_ipc_router(request);
                responder.respond(response)
            },
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sqlynx_get_os() -> &'static str {
    return "darwin";
}

fn sqlynx_ipc_router(_request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let resp = ResponseBuilder::new()
        .header(CONTENT_TYPE, "text/plain")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body("hello world".to_string().as_bytes().to_vec())
        .unwrap();

    resp
}
