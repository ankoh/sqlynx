use tauri::http::Request;
use tauri::http::Response;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;
use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;

pub const HEADER_NAME_ERROR_MESSAGE: &'static str = "sqlynx-error-message";

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

pub async fn create_channel(mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match GRPC_PROXY.create_channel(req.headers_mut()).await {
        Ok(channel_id) => {
            let mut response = Response::builder()
                .status(200)
                .body(Vec::new())
                .unwrap();
            let headers = response.headers_mut();
            headers.insert(HEADER_NAME_CHANNEL_ID, channel_id.into());
            response
        },
        Err(e) => {
            let mut response = Response::builder()
                .status(400)
                .body(Vec::new())
                .unwrap();
            let headers = response.headers_mut();
            headers.insert(HEADER_NAME_ERROR_MESSAGE, e.to_string().parse().unwrap());
            response
        }
    }
}

pub async fn delete_channel(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("delete_channel")
}

pub async fn call_unary(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("call_unary")
}

pub async fn start_server_stream(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("start_server_stream")
}

pub async fn read_server_stream(_channel_id: usize, _stream_id: usize) -> Response<Vec<u8>> {
    unimplemented!("read_server_stream")
}

pub async fn delete_server_stream(_channel_id: usize, _stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("delete_server_stream")
}
