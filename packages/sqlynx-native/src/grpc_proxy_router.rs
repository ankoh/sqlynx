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

pub async fn route_grpc_proxy_request(req: &mut Request<Vec<u8>>) -> Option<Response<Vec<u8>>> {
    if let Some(route) = parse_grpc_proxy_path(req.uri().path()) {
        let response = match (req.method().clone(), route) {
            (Method::POST, GrpcProxyRoute::Channels) => create_channel(std::mem::take(req)).await,
            (Method::DELETE, GrpcProxyRoute::Channel { channel_id }) => delete_channel(channel_id).await,
            (Method::POST, GrpcProxyRoute::ChannelUnary { channel_id }) => call_unary(channel_id, std::mem::take(req)).await,
            (Method::POST, GrpcProxyRoute::ChannelStreams { channel_id }) => start_server_stream(channel_id, std::mem::take(req)).await,
            (Method::GET, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => read_server_stream(channel_id, stream_id, std::mem::take(req)).await,
            (Method::DELETE, GrpcProxyRoute::ChannelStream { channel_id, stream_id }) => delete_server_stream(channel_id, stream_id, std::mem::take(req)).await,
            (_, _) => {
                return None;
            }
        };
        return Some(response);
    }
    return None;
}

#[cfg(test)]
mod test {
    use super::*;

    use crate::grpc_proxy::HEADER_NAME_BATCH_BYTES;
    use crate::grpc_proxy::HEADER_NAME_BATCH_EVENT;
    use crate::grpc_proxy::HEADER_NAME_BATCH_MESSAGES;
    use crate::grpc_proxy::HEADER_NAME_BATCH_TIMEOUT;
    use crate::grpc_proxy::HEADER_NAME_CHANNEL_ID;
    use crate::grpc_proxy::HEADER_NAME_HOST;
    use crate::grpc_proxy::HEADER_NAME_PATH;
    use crate::grpc_proxy::HEADER_NAME_READ_TIMEOUT;
    use crate::grpc_proxy::HEADER_NAME_STREAM_ID;
    use crate::proto::sqlynx_test_v1::TestUnaryRequest;
    use crate::proto::sqlynx_test_v1::TestUnaryResponse;
    use crate::proto::sqlynx_test_v1::TestServerStreamingRequest;
    use crate::proto::sqlynx_test_v1::TestServerStreamingResponse;
    use crate::test::test_service_mock::spawn_test_service_mock;
    use crate::test::test_service_mock::TestServiceMock;

    use anyhow::Result;
    use prost::Message;
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
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

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

    #[tokio::test]
    async fn test_unary_call() -> Result<()> {
        // Spawn a test service mock
        let (mock, mut setup_unary, mut _setup_server_streaming) = TestServiceMock::new();
        let (addr, shutdown) = spawn_test_service_mock(mock).await;
        let host = format!("http://{}", addr);

        // Respond single streaming response
        let unary_call = tokio::spawn(async move {
            let (param, result_sender) = setup_unary.recv().await.unwrap();
            result_sender.send(Ok(TestUnaryResponse {
                data: "response data".to_string()
            })).await.unwrap();
            param
        });

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
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

        // Call unary gRPC call
        let request_param = TestUnaryRequest {
            data: "request data".to_string()
        };
        let mut request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channel/{}/unary", host, channel_id))
            .header(HEADER_NAME_PATH, "/sqlynx.test.v1.TestService/TestUnary")
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(request_param.encode_to_vec())
            .unwrap();
        let response = route_grpc_proxy_request(&mut request).await.unwrap();
        assert_eq!(response.status(), 200);

        // Check received parameter
        let received_param = unary_call.await?;
        let received_response = TestUnaryResponse::decode(response.body().as_slice()).unwrap();
        assert_eq!(received_param.data, "request data");
        assert_eq!(received_response.data, "response data");

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

    #[tokio::test]
    async fn test_streaming_call() -> Result<()> {
        // Spawn a test service mock
        let (mock, mut _setup_unary, mut setup_server_streaming) = TestServiceMock::new();
        let (addr, shutdown) = spawn_test_service_mock(mock).await;
        let host = format!("http://{}", addr);

        // Respond single streaming response
        let _streaming_call = tokio::spawn(async move {
            let (param, result_sender) = setup_server_streaming.recv().await.unwrap();
            result_sender.send(Ok(TestServerStreamingResponse {
                data: "response data".to_string()
            })).await.unwrap();
            param
        });

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
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

        // Call server streaming gRPC call
        let request_param = TestServerStreamingRequest {
            data: "request data".to_string()
        };
        let mut request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channel/{}/streams", host, channel_id))
            .header(HEADER_NAME_PATH, "/sqlynx.test.v1.TestService/TestServerStreaming")
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(request_param.encode_to_vec())
            .unwrap();
        let response = route_grpc_proxy_request(&mut request).await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_STREAM_ID));
        let stream_id = response.headers().get(HEADER_NAME_STREAM_ID).unwrap().to_str().unwrap();
        let stream_id: usize = stream_id.parse().unwrap();

        // Read query results
        let mut request: Request<Vec<u8>> = Request::builder()
            .method("GET")
            .uri(format!("{}/grpc/channel/{}/stream/{}", host, channel_id, stream_id))
            .header(HEADER_NAME_READ_TIMEOUT, "1000")
            .header(HEADER_NAME_BATCH_TIMEOUT, "1000")
            .header(HEADER_NAME_BATCH_BYTES, "10000000")
            .body(Vec::new())
            .unwrap();
        let response = route_grpc_proxy_request(&mut request).await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        assert!(response.headers().contains_key(HEADER_NAME_STREAM_ID));
        assert!(response.headers().contains_key(HEADER_NAME_BATCH_EVENT));
        assert!(response.headers().contains_key(HEADER_NAME_BATCH_MESSAGES));
        assert!(response.headers().contains_key(CONTENT_TYPE));
        let batch_event = response.headers().get(HEADER_NAME_BATCH_EVENT).unwrap().to_str().unwrap();
        let batch_messages = response.headers().get(HEADER_NAME_BATCH_MESSAGES).unwrap().to_str().unwrap();
        assert_eq!(batch_messages, "1");
        assert_eq!(batch_event, "StreamFinished");
        let response_bytes = response.body();
        assert!(response_bytes.len() > 4);
        let response_message = TestServerStreamingResponse::decode(&response_bytes[4..]).unwrap();
        assert_eq!(response_message.data, "response data");

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
