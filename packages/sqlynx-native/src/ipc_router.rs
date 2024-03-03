use axum::Router;
use tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN;
use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use tauri::http::response::Builder as ResponseBuilder;
use lazy_static::lazy_static;

use crate::grpc_proxy_router::create_grpc_router;


lazy_static! {
    static ref ROUTER: axum::routing::Router<()> = Router::new()
        .nest("/grpc", create_grpc_router());
}

pub async fn route_ipc_request(_request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let resp = ResponseBuilder::new()
        .header(CONTENT_TYPE, "text/plain")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body("hello world".to_string().as_bytes().to_vec())
        .unwrap();
    resp
}
