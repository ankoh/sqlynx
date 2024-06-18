use std::io::Write;

use tauri::http::Request;
use tauri::http::Response;
use lazy_static::lazy_static;

use crate::http_proxy::HttpProxy;
use crate::proxy_headers::HEADER_NAME_BATCH_BYTES;
use crate::proxy_headers::HEADER_NAME_BATCH_EVENT;
use crate::proxy_headers::HEADER_NAME_STREAM_ID;

lazy_static! {
    static ref HTTP_PROXY: HttpProxy = HttpProxy::default();
}

pub async fn start_http_server_stream(mut req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let body = std::mem::take(req.body_mut());
    match HTTP_PROXY.start_server_stream(req.headers_mut(), body).await {
        Ok(stream_id) => {
            let response = Response::builder()
                .status(200)
                .header(HEADER_NAME_STREAM_ID, stream_id)
                .body(Vec::new())
                .unwrap();
            response
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn read_http_server_stream(stream_id: usize, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match HTTP_PROXY.read_server_stream(stream_id, req.headers()).await {
        Ok(batches) => {
            let mut buffer: Vec<u8> = Vec::with_capacity(batches.total_body_bytes);
            for message in batches.body_chunks.iter() {
                buffer.write(&message).unwrap();
            }
            let mut response = Response::builder()
                .status(200)
                .header(HEADER_NAME_STREAM_ID, stream_id)
                .header(HEADER_NAME_BATCH_EVENT, batches.event.to_str())
                .header(HEADER_NAME_BATCH_BYTES, batches.total_body_bytes);
            log::debug!("{:?}", batches.headers);
            let headers = &mut response.headers_mut().unwrap();
            for (key, value) in batches.headers.iter() {
                headers.insert(key, value.clone());
            }
            response
                .body(buffer)
                .unwrap()
        },
        Err(e) => Response::from(&e)
    }
}

pub async fn delete_http_server_stream(stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match HTTP_PROXY.destroy_server_stream(stream_id).await {
        Ok(()) => {
            Response::builder()
                .status(200)
                .body(Vec::new())
                .unwrap()
        }
        Err(e) => Response::from(&e)
    }
}
