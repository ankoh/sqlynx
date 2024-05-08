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
use crate::test::grpc_service_mock::spawn_grpc_test_service_mock;
use crate::test::grpc_service_mock::GrpcServiceMock;
use crate::ipc_router::route_ipc_request;

use anyhow::Result;
use prost::Message;
use tauri::http::header::CONTENT_TYPE;
use tauri::http::Request;

#[tokio::test]
async fn test_grpc_channel_setup() -> anyhow::Result<()> {
    // Spawn a test service mock
    let (mock, mut _setup_unary, mut _setup_server_streaming) = GrpcServiceMock::new();
    let (addr, shutdown) = spawn_grpc_test_service_mock(mock).await;
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
async fn test_unary_grpc_call() -> Result<()> {
    // Spawn a test service mock
    let (mock, mut setup_unary, mut _setup_server_streaming) = GrpcServiceMock::new();
    let (addr, shutdown) = spawn_grpc_test_service_mock(mock).await;
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
async fn test_streaming_grpc_call() -> Result<()> {
    // Spawn a test service mock
    let (mock, mut _setup_unary, mut setup_server_streaming) = GrpcServiceMock::new();
    let (addr, shutdown) = spawn_grpc_test_service_mock(mock).await;
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
