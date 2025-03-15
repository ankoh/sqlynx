use lazy_static::lazy_static;
use regex_automata::util::captures::Captures;
use regex_automata::meta::Regex;

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

#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;

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
}
