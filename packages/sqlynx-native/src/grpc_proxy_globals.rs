use tauri::http::header::CONTENT_TYPE;
use tauri::http::HeaderMap;
use tauri::http::HeaderName;
use tauri::http::HeaderValue;
use tauri::http::Request;
use tauri::http::Response;
use tonic::metadata::MetadataMap;
use tonic::metadata::KeyAndMutValueRef;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;
use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;
use crate::grpc_proxy::HEADER_NAME_STREAM_ID;
use crate::grpc_proxy::HEADER_PREFIX;

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

fn copy_metadata(metadata: &mut MetadataMap, headers: &mut HeaderMap) {
    for entry in metadata.iter_mut() {
        match entry {
            KeyAndMutValueRef::Ascii(k, v) => {
                if k.as_str().starts_with(HEADER_PREFIX) {
                    continue;
                }
                let k = HeaderName::from_bytes(k.as_str().as_bytes()).ok();
                let v = HeaderValue::from_str(v.to_str().unwrap_or_default()).ok();
                if let (Some(k), Some(v)) = (k, v) {
                    headers.insert(k, v);
                }
            },
            KeyAndMutValueRef::Binary(k, v) => {
                if k.as_str().starts_with(HEADER_PREFIX) {
                    continue;
                }
                let k = HeaderName::from_bytes(k.as_str().as_bytes()).ok();
                let v = HeaderValue::from_bytes(&v.to_bytes().unwrap_or_default()).ok();
                if let (Some(k), Some(v)) = (k, v) {
                    headers.insert(k, v);
                }
            },
        }
    }
}

pub async fn call_unary(channel_id: usize, mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let body = std::mem::take(req.body_mut());
    match GRPC_PROXY.call_unary(channel_id, req.headers(), body).await {
        Ok((body, mut metadata)) => {
            let mut response = Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(body)
                .unwrap();
            copy_metadata(&mut metadata, response.headers_mut());
            response
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn start_server_stream(channel_id: usize, mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let body = std::mem::take(req.body_mut());
    match GRPC_PROXY.start_server_stream(channel_id, req.headers(), body).await {
        Ok(stream_id) => {
            Response::builder()
                .status(200)
                .header(HEADER_NAME_CHANNEL_ID, channel_id)
                .header(HEADER_NAME_STREAM_ID, stream_id)
                .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
                .body(Vec::new())
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
