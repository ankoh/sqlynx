use tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN;
use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use tauri::http::HeaderValue;

use crate::grpc_proxy_router::route_grpc_proxy_request;

async fn route_ipc_request(mut request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if let Some(response) = route_grpc_proxy_request(&mut request).await {
        return response;
    }
    Response::builder()
        .status(400)
        .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
        .body("cannot find route for request path".as_bytes().to_vec())
        .unwrap()
}

pub async fn process_ipc_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut response = route_ipc_request(request).await;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(mime::APPLICATION_OCTET_STREAM.essence_str()));
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response
}
