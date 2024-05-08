use std::sync::Arc;
use crate::ipc_router::route_ipc_request;
use crate::proxy_headers::HEADER_NAME_ENDPOINT;
use crate::proxy_headers::HEADER_NAME_METHOD;
use crate::proxy_headers::HEADER_NAME_PATH;
use crate::proxy_headers::HEADER_NAME_READ_TIMEOUT;
use crate::proxy_headers::HEADER_NAME_BATCH_TIMEOUT;
use crate::proxy_headers::HEADER_NAME_BATCH_BYTES;
use crate::proxy_headers::HEADER_NAME_STREAM_ID;
use crate::test::http_server_mock::spawn_http_service_mock;
use crate::test::http_server_mock::HttpServiceMock;
use crate::test::http_server_mock::PartialResponse;
use http::header::CONTENT_TYPE;
use http::HeaderMap;
use http::HeaderValue;
use http::Request;
use http::StatusCode;

#[tokio::test]
async fn test_http_stream_setup() -> anyhow::Result<()> {
    let _ = env_logger::try_init();

    // Spawn a test service mock
    let (mock_server, mut setup_http_server) = HttpServiceMock::new();
    let (addr, shutdown) = spawn_http_service_mock(Arc::new(mock_server)).await;
    let host = format!("http://{}", addr);

    let handler = tokio::spawn(async move {
        let (_request, result_sender) = setup_http_server.recv().await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("sqlynx-test-header", HeaderValue::from_str("foo").unwrap());
        result_sender.send(PartialResponse::Header(StatusCode::OK, headers)).await.unwrap();
        result_sender.send(PartialResponse::BodyChunk(vec![1, 2, 3, 4])).await.unwrap();
        result_sender.send(PartialResponse::BodyChunk(vec![5, 6, 7, 8])).await.unwrap();
        drop(result_sender);
    });

    // Create http stream
    let request: Request<Vec<u8>> = Request::builder()
        .method("POST")
        .uri(format!("{}/http/streams", host))
        .header(HEADER_NAME_METHOD, "GET")
        .header(HEADER_NAME_ENDPOINT, &host)
        .header(HEADER_NAME_PATH, "/foo")
        .header(HEADER_NAME_READ_TIMEOUT, "10000")
        .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
        .body(Vec::new())
        .unwrap();
    let response = route_ipc_request(request).await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().contains_key(HEADER_NAME_STREAM_ID));
    let stream_id = response.headers().get(HEADER_NAME_STREAM_ID).unwrap().to_str().unwrap();
    let stream_id: usize = stream_id.parse().unwrap();

    // Read from a http stream
    let request: Request<Vec<u8>> = Request::builder()
        .method("GET")
        .uri(format!("{}/http/stream/{}", host, stream_id))
        .header(HEADER_NAME_STREAM_ID, stream_id.to_string())
        .header(HEADER_NAME_READ_TIMEOUT, "10000")
        .header(HEADER_NAME_BATCH_TIMEOUT, "10000")
        .header(HEADER_NAME_BATCH_BYTES, "10000")
        .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
        .body(Vec::new())
        .unwrap();
    let response = route_ipc_request(request).await;
    assert_eq!(response.status(), 200);

    // Delete http channel
    let request: Request<Vec<u8>> = Request::builder()
        .method("DELETE")
        .uri(format!("{}/http/stream/{}", host, stream_id))
        .header(HEADER_NAME_STREAM_ID, stream_id.to_string())
        .header(CONTENT_TYPE, mime::APPLICATION_OCTET_STREAM.essence_str())
        .body(Vec::new())
        .unwrap();
    let response = route_ipc_request(request).await;
    assert_eq!(response.status(), 200);

    shutdown.send(()).unwrap();
    handler.await.unwrap();
    Ok(())
}
