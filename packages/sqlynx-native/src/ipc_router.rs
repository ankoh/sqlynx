use lazy_static::lazy_static;
use tauri::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE};
use tauri::http::response::Builder as ResponseBuilder;
use tauri::http::Request;
use tauri::http::Response;

use crate::grpc_proxy::GrpcHttpProxy;

lazy_static! {
    static ref GRPC_PROXY: GrpcHttpProxy = GrpcHttpProxy::default();
}

pub async fn route_ipc_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();

    match uri.path() {
        "/grpc/call-unary" => {
            // XXX
            GRPC_PROXY.call_unary(request).await;
        }
        "/grpc/start-server-stream" => {
            // XXX
            GRPC_PROXY.start_server_stream(request).await;
        }
        "/grpc/read-server-stream" => {
            // XXX
            GRPC_PROXY.read_server_stream(request).await;
        }
        "/grpc/cancel-server-stream" => {}
        _ => {
            // Report unknown
        }
    };

    let resp = ResponseBuilder::new()
        .header(CONTENT_TYPE, "text/plain")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body("hello world".to_string().as_bytes().to_vec())
        .unwrap();
    resp
}
