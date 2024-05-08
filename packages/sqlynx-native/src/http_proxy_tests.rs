use std::sync::Arc;
use crate::test::http_server_mock::spawn_http_service_mock;
use crate::test::http_server_mock::HttpServiceMock;

#[tokio::test]
async fn test_http_stream_setup() -> anyhow::Result<()> {
    // Spawn a test service mock
    let (mock_server, mut _setup_http_server) = HttpServiceMock::new();
    let (addr, shutdown) = spawn_http_service_mock(Arc::new(mock_server)).await;
    let _host = format!("http://{}", addr);


    shutdown.send(()).unwrap();
    Ok(())
}
