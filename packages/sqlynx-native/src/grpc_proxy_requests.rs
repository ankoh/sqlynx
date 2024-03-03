use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;
use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

pub async fn create_channel(mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match GRPC_PROXY.create_channel(req.headers_mut()).await {
        Ok(channel_id) => {
            let mut response = Response::builder()
                .status(200)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(Vec::new())
                .unwrap();
            let headers = response.headers_mut();
            headers.insert(HEADER_NAME_CHANNEL_ID, channel_id.into());
            response
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn delete_channel(channel_id: usize) -> Response<Vec<u8>> {
    match GRPC_PROXY.destroy_channel(channel_id).await {
        Ok(()) => {
            let response = Response::builder()
                .status(200)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(Vec::new())
                .unwrap();
            response
        },
        Err(e) => Response::from(&e)

    }
}

pub async fn call_unary(channel_id: usize, mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let body = std::mem::take(req.body_mut());
    match GRPC_PROXY.call_unary(channel_id, req.headers(), body).await {
        Ok(body) => {
            let response = Response::builder()
                .status(200)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(body)
                .unwrap();
            response
        },
        Err(e) => Response::from(&e)
    }
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
