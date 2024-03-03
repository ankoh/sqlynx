use tauri::http::Request;
use tauri::http::Response;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

pub async fn create_channel(_req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("create_channel")
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

pub async fn read_server_stream(_channel_id: usize, _stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("read_server_stream")
}

pub async fn delete_server_stream(_channel_id: usize, _stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("delete_server_stream")
}
