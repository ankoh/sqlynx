use http::Method;
use tauri::http::header::ACCESS_CONTROL_EXPOSE_HEADERS;
use tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN;
use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;
use tauri::http::Response;
use tauri::http::HeaderValue;

use crate::grpc_proxy_globals::call_grpc_unary;
use crate::grpc_proxy_globals::create_grpc_channel;
use crate::grpc_proxy_globals::delete_grpc_channel;
use crate::grpc_proxy_globals::delete_grpc_server_stream;
use crate::grpc_proxy_globals::read_grpc_server_stream;
use crate::grpc_proxy_globals::start_grpc_server_stream;
use crate::grpc_proxy_routes::GrpcProxyRoute;
use crate::grpc_proxy_routes::parse_grpc_proxy_path;
use crate::http_proxy_globals::delete_http_server_stream;
use crate::http_proxy_globals::read_http_server_stream;
use crate::http_proxy_globals::start_http_server_stream;
use crate::http_proxy_routes::HttpProxyRoute;
use crate::http_proxy_routes::parse_http_proxy_path;

pub async fn route_ipc_request(mut request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    log::debug!("received ipc request with path={}", request.uri().path());

    // Handle HTTP requests
    if let Some(route) = parse_http_proxy_path(request.uri().path()) {
        log::debug!("matching http proxy route={:?}, method={:?}", route, request.method());
        let response = match (request.method().clone(), route) {
            (Method::POST, HttpProxyRoute::Streams { }) => start_http_server_stream(std::mem::take(&mut request)).await,
            (Method::GET, HttpProxyRoute::Stream { stream_id }) => read_http_server_stream(stream_id, std::mem::take(&mut request)).await,
            (Method::DELETE, HttpProxyRoute::Stream { stream_id }) => delete_http_server_stream(stream_id, std::mem::take(&mut request)).await,
            (_, _) => {
                let body = format!("cannot find handler for grpc proxy route={:?}, method={:?}", request.uri().path(), request.method());
                return Response::builder()
                    .status(404)
                    .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
                    .body(body.as_bytes().to_vec())
                    .unwrap();
            }
        };
        return response;
    }

    // Handle gRPC requests
    if let Some(route) = parse_grpc_proxy_path(request.uri().path()) {
        log::debug!("matching grpc proxy route={:?}, method={:?}", route, request.method());
        let response = match (request.method().clone(), route) {
            (Method::POST, GrpcProxyRoute::Channels) => create_grpc_channel(std::mem::take(&mut request)).await,
            (Method::DELETE, GrpcProxyRoute::Channel { channel_id }) => delete_grpc_channel(channel_id).await,
            (Method::POST, GrpcProxyRoute::ChannelUnary { channel_id }) => call_grpc_unary(channel_id, std::mem::take(&mut request)).await,
            (Method::POST, GrpcProxyRoute::ChannelStreams { channel_id }) => start_grpc_server_stream(channel_id, std::mem::take(&mut request)).await,
            (Method::GET, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => read_grpc_server_stream(channel_id, stream_id, std::mem::take(&mut request)).await,
            (Method::DELETE, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => delete_grpc_server_stream(channel_id, stream_id, std::mem::take(&mut request)).await,
            (_, _) => {
                let body = format!("cannot find handler for http proxy route={:?}, method={:?}", request.uri().path(), request.method());
                return Response::builder()
                    .status(404)
                    .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
                    .body(body.as_bytes().to_vec())
                    .unwrap();
            }
        };
        log::debug!("grpc proxy responded with {:?}", response);
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
    headers.insert(ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("*"));
    response
}
