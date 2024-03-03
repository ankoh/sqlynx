use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;
use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;
use crate::grpc_proxy::HEADER_NAME_STREAM_ID;

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

pub async fn create_channel(mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match GRPC_PROXY.create_channel(req.headers_mut()).await {
        Ok(channel_id) => {
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(Vec::new())
                .unwrap()
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
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(body)
                .unwrap()
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn start_server_stream(channel_id: usize, mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let body = std::mem::take(req.body_mut());
    match GRPC_PROXY.start_server_stream(channel_id, req.headers(), body).await {
        Ok((stream_id, body)) => {
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(HEADER_NAME_STREAM_ID, stream_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(body)
                .unwrap()
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn read_server_stream(channel_id: usize, stream_id: usize, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match GRPC_PROXY.read_server_stream(channel_id, stream_id, req.headers()).await {
        Ok(body) => {
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(HEADER_NAME_STREAM_ID, stream_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(body)
                .unwrap()
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn delete_server_stream(channel_id: usize, stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match GRPC_PROXY.destroy_server_stream(channel_id, stream_id).await {
        Ok(()) => {
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(Vec::new())
                .unwrap()
        }
        Err(e) => Response::from(&e)
    }
}
