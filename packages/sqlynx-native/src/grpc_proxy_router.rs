use lazy_static::lazy_static;
use regex_automata::util::captures::Captures;
use tauri::http::Method;
use tauri::http::Request;
use tauri::http::Response;
use regex_automata::meta::Regex;

use crate::grpc_proxy_globals::call_unary;
use crate::grpc_proxy_globals::create_channel;
use crate::grpc_proxy_globals::delete_channel;
use crate::grpc_proxy_globals::delete_server_stream;
use crate::grpc_proxy_globals::read_server_stream;
use crate::grpc_proxy_globals::start_server_stream;

#[derive(Debug, PartialEq)]
pub enum GrpcProxyRoute {
    Channels,
    Channel { channel_id: usize } ,
    ChannelUnary { channel_id: usize },
    ChannelStreams { channel_id: usize },
    ChannelStream { channel_id: usize, stream_id: usize },
}

lazy_static! {
    static ref ROUTES: Regex = Regex::new_many(&[
        r"^/grpc/channels$",
        r"^/grpc/channel/(\d+)$",
        r"^/grpc/channel/(\d+)/unary$",
        r"^/grpc/channel/(\d+)/streams$",
        r"^/grpc/channel/(\d+)/stream/(\d+)$",
    ]).unwrap();
}

pub fn parse_grpc_proxy_path(path: &str) -> Option<GrpcProxyRoute> {
    let mut all = Captures::all(ROUTES.group_info().clone());
    ROUTES.captures(path, &mut all);
    match all.pattern().map(|p| p.as_usize()) {
        Some(0) => {
            Some(GrpcProxyRoute::Channels)
        }
        Some(1) => {
            let channel_id = path[all.get_group(1).unwrap()].parse().unwrap_or_default();
            Some(GrpcProxyRoute::Channel { channel_id })
        }
        Some(2) => {
            let channel_id = path[all.get_group(1).unwrap()].parse().unwrap_or_default();
            Some(GrpcProxyRoute::ChannelUnary { channel_id })
        }
        Some(3) => {
            let channel_id = path[all.get_group(1).unwrap()].parse().unwrap_or_default();
            Some(GrpcProxyRoute::ChannelStreams { channel_id })
        }
        Some(4) => {
            let channel_id = path[all.get_group(1).unwrap()].parse().unwrap_or_default();
            let stream_id = path[all.get_group(2).unwrap()].parse().unwrap_or_default();
            Some(GrpcProxyRoute::ChannelStream { channel_id, stream_id })
        }
        _ => {
            None
        }
    }
}

pub async fn dispatch_grpc_proxy_route(route: GrpcProxyRoute, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match (req.method().clone(), route) {
        (Method::POST, GrpcProxyRoute::Channels) => create_channel(req).await,
        (Method::DELETE, GrpcProxyRoute::Channel { channel_id }) => delete_channel(channel_id).await,
        (Method::POST, GrpcProxyRoute::ChannelUnary { channel_id }) => call_unary(channel_id, req).await,
        (Method::POST, GrpcProxyRoute::ChannelStreams { channel_id }) => start_server_stream(channel_id, req).await,
        (Method::GET, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => read_server_stream(channel_id, stream_id, req).await,
        (Method::DELETE, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => delete_server_stream(channel_id, stream_id, req).await,
        (_, _) => {
            unreachable!();
        }
    }
}

pub async fn route_grpc_proxy_request(request: &mut Request<Vec<u8>>) -> Option<Response<Vec<u8>>> {
    if let Some(route) = parse_grpc_proxy_path(request.uri().path()) {
        return Some(dispatch_grpc_proxy_route(route, std::mem::take(request)).await);
    }
    return None;
}

#[cfg(test)]
mod test {
    use super::*;

    use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;
    use crate::grpc_proxy::HEADER_NAME_HOST;
    use crate::test::test_service_mock::spawn_test_service_mock;
    use crate::test::test_service_mock::TestServiceMock;

    use anyhow::Result;
    use tauri::http::header::CONTENT_TYPE;
    use tauri::http::Request;

    #[tokio::test]
    async fn test_valid_routes() -> Result<()> {
        assert_eq!(parse_grpc_proxy_path("/grpc/channels"), Some(GrpcProxyRoute::Channels));
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1"), Some(GrpcProxyRoute::Channel { channel_id: 1 }));
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/unary"), Some(GrpcProxyRoute::ChannelUnary { channel_id: 1 }));
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/streams"), Some(GrpcProxyRoute::ChannelStreams { channel_id: 1 }));
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/stream/2"), Some(GrpcProxyRoute::ChannelStream { channel_id: 1, stream_id: 2 }));
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/123/stream/456"), Some(GrpcProxyRoute::ChannelStream { channel_id: 123, stream_id: 456 }));
        Ok(())
    }

    #[tokio::test]
    async fn test_invalid_routes() -> Result<()> {
        assert_eq!(parse_grpc_proxy_path("/grpc/foo"), None);
        assert_eq!(parse_grpc_proxy_path("/grpc/channels/foo"), None);
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/foo"), None);
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/foo"), None);
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/stream/foo"), None);
        assert_eq!(parse_grpc_proxy_path("/grpc/channel/1/stream/2/foo"), None);
        Ok(())
    }

    #[tokio::test]
    async fn test_channel_setup() -> anyhow::Result<()> {
        // Spawn a test service mock
        let (mock, mut _setup_unary, mut _setup_server_streaming) = TestServiceMock::new();
        let (addr, shutdown) = spawn_test_service_mock(mock).await;
        let host = format!("http://{}", addr);

        // Create gRPC channel
        let mut request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channels", host))
            .header(HEADER_NAME_HOST, &host)
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_grpc_proxy_request(&mut request).await.unwrap();
        assert_eq!(response.status(), 200);

        // Get channel id
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        assert!(!channel_id.is_empty());

        // Delete gRPC channel
        let mut request: Request<Vec<u8>> = Request::builder()
            .method("DELETE")
            .uri(format!("{}/grpc/channel/{}", host, channel_id))
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_grpc_proxy_request(&mut request).await.unwrap();
        assert_eq!(response.status(), 200);

        shutdown.send(()).unwrap();
        Ok(())
    }
}
