use lazy_static::lazy_static;
use tauri::http::Method;
use tauri::http::Request;
use tauri::http::Response;
use regex::Regex;

use crate::grpc_proxy::GrpcProxy;

#[derive(Debug, PartialEq)]
pub enum GrpcProxyRoute {
    Channels,
    Channel { channel_id: usize } ,
    ChannelUnary { channel_id: usize },
    ChannelStreams { channel_id: usize },
    ChannelStream { channel_id: usize, stream_id: usize },
}

lazy_static! {
    static ref ROUTE_CHANNELS: Regex = Regex::new(r"^/grpc/channels$").unwrap();
    static ref ROUTE_CHANNEL: Regex = Regex::new(r"^/grpc/channel/(\d+)$").unwrap();
    static ref ROUTE_CHANNEL_UNARY: Regex = Regex::new(r"^/grpc/channel/(\d+)/unary$").unwrap();
    static ref ROUTE_CHANNEL_STREAMS: Regex = Regex::new(r"^/grpc/channel/(\d+)/streams$").unwrap();
    static ref ROUTE_CHANNEL_STREAM: Regex = Regex::new(r"^/grpc/channel/(\d+)/stream/(\d+)$").unwrap();
}

pub fn parse_grpc_route(uri: &str) -> Option<GrpcProxyRoute> {
    if ROUTE_CHANNELS.is_match(uri) {
        return Some(GrpcProxyRoute::Channels)
    }
    if let Some(captures) = ROUTE_CHANNEL.captures(uri) {
        let channel_id: usize = captures[1].parse().unwrap_or_default();
        return Some(GrpcProxyRoute::Channel{ channel_id });
    }
    if let Some(captures) = ROUTE_CHANNEL_UNARY.captures(uri) {
        let channel_id: usize = captures[1].parse().unwrap_or_default();
        return Some(GrpcProxyRoute::ChannelUnary{ channel_id });
    }
    if let Some(captures) = ROUTE_CHANNEL_STREAMS.captures(uri) {
        let channel_id: usize = captures[1].parse().unwrap_or_default();
        return Some(GrpcProxyRoute::ChannelStreams{ channel_id });
    }
    if let Some(captures) = ROUTE_CHANNEL_STREAM.captures(uri) {
        let channel_id: usize = captures[1].parse().unwrap_or_default();
        let stream_id: usize = captures[2].parse().unwrap_or_default();
        return Some(GrpcProxyRoute::ChannelStream{ channel_id, stream_id });
    }
    None
}

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

async fn create_channel(_req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("create_channel")
}

async fn delete_channel(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("delete_channel")
}

async fn call_unary(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("call_unary")
}

async fn start_server_stream(_channel_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("start_server_stream")
}

async fn read_server_stream(_channel_id: usize, _stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("read_server_stream")
}

async fn delete_server_stream(_channel_id: usize, _stream_id: usize, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    unimplemented!("delete_server_stream")
}


pub async fn call_grpc_proxy(route: GrpcProxyRoute, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match (req.method().clone(), route) {
        (Method::POST, GrpcProxyRoute::Channels) => create_channel(req).await,
        (Method::DELETE, GrpcProxyRoute::Channel { channel_id }) => delete_channel(channel_id, req).await,
        (Method::POST, GrpcProxyRoute::ChannelUnary { channel_id }) => call_unary(channel_id, req).await,
        (Method::POST, GrpcProxyRoute::ChannelStreams { channel_id }) => start_server_stream(channel_id, req).await,
        (Method::GET, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => read_server_stream(channel_id, stream_id, req).await,
        (Method::DELETE, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => delete_server_stream(channel_id, stream_id, req).await,
        (_, _) => {
            Response::builder()
                .status(400)
                .body(Vec::new())
                .unwrap()
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;

    #[tokio::test]
    async fn test_valid_routes() -> Result<()> {
        assert_eq!(parse_grpc_route("/grpc/channels"), Some(GrpcProxyRoute::Channels));
        assert_eq!(parse_grpc_route("/grpc/channel/1"), Some(GrpcProxyRoute::Channel { channel_id: 1 }));
        assert_eq!(parse_grpc_route("/grpc/channel/1/unary"), Some(GrpcProxyRoute::ChannelUnary { channel_id: 1 }));
        assert_eq!(parse_grpc_route("/grpc/channel/1/streams"), Some(GrpcProxyRoute::ChannelStreams { channel_id: 1 }));
        assert_eq!(parse_grpc_route("/grpc/channel/1/stream/2"), Some(GrpcProxyRoute::ChannelStream { channel_id: 1, stream_id: 2 }));
        assert_eq!(parse_grpc_route("/grpc/channel/123/stream/456"), Some(GrpcProxyRoute::ChannelStream { channel_id: 123, stream_id: 456 }));
        Ok(())
    }

    #[tokio::test]
    async fn test_invalid_routes() -> Result<()> {
        assert_eq!(parse_grpc_route("/grpc/foo"), None);
        assert_eq!(parse_grpc_route("/grpc/channels/foo"), None);
        assert_eq!(parse_grpc_route("/grpc/channel/foo"), None);
        assert_eq!(parse_grpc_route("/grpc/channel/1/foo"), None);
        assert_eq!(parse_grpc_route("/grpc/channel/1/stream/foo"), None);
        assert_eq!(parse_grpc_route("/grpc/channel/1/stream/2/foo"), None);
        Ok(())
    }
}
