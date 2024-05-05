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

async fn route_ipc_request(mut request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    log::trace!("received ipc request with path={}", request.uri().path());

    // Handle HTTP requests
    if let Some(route) = parse_http_proxy_path(request.uri().path()) {
        log::trace!("matching http proxy route={:?}, method={:?}", route, request.method());
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
        log::trace!("http proxy responded with {:?}", response);
        return response;
    }

    // Handle gRPC requests
    if let Some(route) = parse_grpc_proxy_path(request.uri().path()) {
        log::trace!("matching grpc proxy route={:?}, method={:?}", route, request.method());
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
        log::trace!("grpc proxy responded with {:?}", response);
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

#[cfg(test)]
mod test {
    use super::*;

    use crate::proxy_headers::HEADER_NAME_BATCH_BYTES;
    use crate::proxy_headers::HEADER_NAME_BATCH_EVENT;
    use crate::proxy_headers::HEADER_NAME_BATCH_MESSAGES;
    use crate::proxy_headers::HEADER_NAME_BATCH_TIMEOUT;
    use crate::proxy_headers::HEADER_NAME_CHANNEL_ID;
    use crate::proxy_headers::HEADER_NAME_ENDPOINT;
    use crate::proxy_headers::HEADER_NAME_PATH;
    use crate::proxy_headers::HEADER_NAME_READ_TIMEOUT;
    use crate::proxy_headers::HEADER_NAME_STREAM_ID;
    use crate::proto::sqlynx_test::TestUnaryRequest;
    use crate::proto::sqlynx_test::TestUnaryResponse;
    use crate::proto::sqlynx_test::TestServerStreamingRequest;
    use crate::proto::sqlynx_test::TestServerStreamingResponse;
    use crate::test::test_service_mock::spawn_test_service_mock;
    use crate::test::test_service_mock::TestServiceMock;

    use anyhow::Result;
    use prost::Message;
    use tauri::http::header::CONTENT_TYPE;
    use tauri::http::Request;

    #[tokio::test]
    async fn test_channel_setup() -> anyhow::Result<()> {
        // Spawn a test service mock
        let (mock, mut _setup_unary, mut _setup_server_streaming) = TestServiceMock::new();
        let (addr, shutdown) = spawn_test_service_mock(mock).await;
        let host = format!("http://{}", addr);

        // Create gRPC channel
        let request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channels", host))
            .header(HEADER_NAME_ENDPOINT, &host)
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

        // Delete gRPC channel
        let request: Request<Vec<u8>> = Request::builder()
            .method("DELETE")
            .uri(format!("{}/grpc/channel/{}", host, channel_id))
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
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
        let request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channels", host))
            .header(HEADER_NAME_ENDPOINT, &host)
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

        // Call unary gRPC call
        let request_param = TestUnaryRequest {
            data: "request data".to_string()
        };
        let request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channel/{}/unary", host, channel_id))
            .header(HEADER_NAME_PATH, "/sqlynx.test.TestService/TestUnary")
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(request_param.encode_to_vec())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);

        // Check received parameter
        let received_param = unary_call.await?;
        let received_response = TestUnaryResponse::decode(response.body().as_slice()).unwrap();
        assert_eq!(received_param.data, "request data");
        assert_eq!(received_response.data, "response data");

        // Delete gRPC channel
        let request: Request<Vec<u8>> = Request::builder()
            .method("DELETE")
            .uri(format!("{}/grpc/channel/{}", host, channel_id))
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
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
        let request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channels", host))
            .header(HEADER_NAME_ENDPOINT, &host)
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        let channel_id = response.headers().get(HEADER_NAME_CHANNEL_ID).unwrap().to_str().unwrap();
        let channel_id: usize = channel_id.parse().unwrap();

        // Call server streaming gRPC call
        let request_param = TestServerStreamingRequest {
            data: "request data".to_string()
        };
        let request: Request<Vec<u8>> = Request::builder()
            .method("POST")
            .uri(format!("{}/grpc/channel/{}/streams", host, channel_id))
            .header(HEADER_NAME_PATH, "/sqlynx.test.TestService/TestServerStreaming")
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(request_param.encode_to_vec())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_STREAM_ID));
        let stream_id = response.headers().get(HEADER_NAME_STREAM_ID).unwrap().to_str().unwrap();
        let stream_id: usize = stream_id.parse().unwrap();

        // Read query results
        let request: Request<Vec<u8>> = Request::builder()
            .method("GET")
            .uri(format!("{}/grpc/channel/{}/stream/{}", host, channel_id, stream_id))
            .header(HEADER_NAME_READ_TIMEOUT, "1000")
            .header(HEADER_NAME_BATCH_TIMEOUT, "1000")
            .header(HEADER_NAME_BATCH_BYTES, "10000000")
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key(HEADER_NAME_CHANNEL_ID));
        assert!(response.headers().contains_key(HEADER_NAME_STREAM_ID));
        assert!(response.headers().contains_key(HEADER_NAME_BATCH_EVENT));
        assert!(response.headers().contains_key(HEADER_NAME_BATCH_MESSAGES));
        let batch_event = response.headers().get(HEADER_NAME_BATCH_EVENT).unwrap().to_str().unwrap();
        let batch_messages = response.headers().get(HEADER_NAME_BATCH_MESSAGES).unwrap().to_str().unwrap();
        assert_eq!(batch_messages, "1");
        assert_eq!(batch_event, "StreamFinished");
        let response_bytes = response.body();
        assert!(response_bytes.len() > 4);
        let response_message = TestServerStreamingResponse::decode(&response_bytes[4..]).unwrap();
        assert_eq!(response_message.data, "response data");

        // Delete gRPC channel
        let request: Request<Vec<u8>> = Request::builder()
            .method("DELETE")
            .uri(format!("{}/grpc/channel/{}", host, channel_id))
            .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
            .body(Vec::new())
            .unwrap();
        let response = route_ipc_request(request).await;
        assert_eq!(response.status(), 200);

        shutdown.send(()).unwrap();
        Ok(())
    }
}
