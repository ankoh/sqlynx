use tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN;
use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use tauri::http::HeaderValue;

use crate::grpc_proxy_router::call_grpc_proxy;
use crate::grpc_proxy_router::parse_grpc_route;

async fn dispatch_ipc_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if let Some(route) = parse_grpc_route(request.uri().path()) {
        return call_grpc_proxy(route, request).await;
    }
    Response::builder()
        .status(400)
        .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
        .body("cannot find route for request path".as_bytes().to_vec())
        .unwrap()
}

pub async fn route_ipc_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut response = dispatch_ipc_request(request).await;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(mime::APPLICATION_OCTET_STREAM.essence_str()));
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response
}
