use http::{HeaderMap, HeaderValue};
use http_body_util::{Full, StreamBody};
use hyper::body::Body;
use hyper::body::Frame;
use hyper::body;
use hyper::{Request, Response};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_stream::wrappers::ReceiverStream;

pub enum PartialResponse {
    Header(reqwest::StatusCode, HeaderMap<HeaderValue>),
    BodyChunk(Vec<u8>)
}

pub type ResponseSender = tokio::sync::mpsc::Sender<PartialResponse>;

pub struct HttpServiceMock {
    pub setup_server_stream: tokio::sync::mpsc::Sender<(Request<body::Incoming>, ResponseSender)>,
}

impl HttpServiceMock {
    pub async fn handle_request(&self, request: Request<body::Incoming>) -> hyper::Result<Response<Pin<Box<dyn Body<Data = bytes::Bytes, Error = Infallible> + Send>>>> {
        // Setup a channel for sending the result
        let (result_sender, mut receiver) = tokio::sync::mpsc::channel(1);

        // Pass the result_sender back to the test, together with the request params
        let test_setup = self.setup_server_stream.clone();
        test_setup.send((request, result_sender)).await.unwrap();
        let mut response_builder = Response::builder();

        // Try to receive the initial header message
        let response = match receiver.recv().await {
            Some(response) => response,
            None => {
                let mut response = Response::builder();
                response = response.status(500);
                let body_data = bytes::Bytes::from("receiver was closed before providing a header".to_string());
                let body: Pin<Box<dyn Body<Data = bytes::Bytes, Error = Infallible> + Send>> = Box::pin(Full::new(body_data));
                let response = response.body(body).unwrap();
                return Ok(response);
            }
        };
        // Unpack the header message
        match response {
            PartialResponse::Header(status, mut headers) => {
                response_builder = response_builder.status(status);
                *response_builder.headers_mut().unwrap() = std::mem::take(&mut headers);
            },
            PartialResponse::BodyChunk(_body) => {
                log::error!("http service mock received a response body as first message");
            }
        }

        // Setup the stream body
        let (body_sender, body_receiver) = tokio::sync::mpsc::channel::<Result<Frame<bytes::Bytes>, Infallible>>(1);
        let body_stream: ReceiverStream<Result<Frame::<bytes::Bytes>, Infallible>> = ReceiverStream::new(body_receiver);
        let body: Pin<Box<dyn Body<Data = bytes::Bytes, Error = Infallible> + Send>> = Box::pin(StreamBody::new(body_stream));
        let response = response_builder.body(body).unwrap();

        // Spawn the body forwarder
        tokio::spawn(async move {
            while let Some(next) = receiver.recv().await {
                match next {
                    PartialResponse::Header(_status, _headers) => {
                        log::error!("http service mock received a header message when streaming the body");
                    },
                    PartialResponse::BodyChunk(body) => {
                        log::trace!("forwarded {} bytes to stream body", body.len());
                        let data = bytes::Bytes::from(body);
                        let frame = hyper::body::Frame::data(data);
                        body_sender.send(Ok(frame)).await.expect("failed to forward response body to the writer");
                    }
                }
            }
        });
        Ok(response)
    }

    pub fn new() -> (Self, tokio::sync::mpsc::Receiver<(Request<body::Incoming>, ResponseSender)>) {
        let (setup_server_stream, recv_server_stream) = tokio::sync::mpsc::channel(1);
        (Self { setup_server_stream }, recv_server_stream)
    }
}

async fn accept_connections(listener: tokio::net::TcpListener, mut shutdown_rx: oneshot::Receiver<()>, mock: Arc<HttpServiceMock>) {
    loop {
        tokio::select! {
            conn = listener.accept() => {
                // Await next incoming connection
                let (stream, peer_addr) = match conn {
                    Ok(conn) => conn,
                    Err(e) => {
                        log::error!("accept error: {}", e);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                };
                log::debug!("incoming connection accepted: {}", peer_addr);
                let stream = hyper_util::rt::TokioIo::new(Box::pin(stream));

                // Handle request
                let mock_copy = mock.clone();
                let service_fn = move |req: Request<body::Incoming>| {
                    let mock_copy = mock_copy.clone();
                    async move {
                        mock_copy.handle_request(req).await
                    }
                };
                // Spawn the request handler
                tokio::spawn(async move {
                    let server = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
                    let conn = server.serve_connection_with_upgrades(stream, hyper::service::service_fn(service_fn));
                    if let Err(err) = conn.await {
                        log::error!("connection error: {}", err);
                    }
                    log::info!("connection dropped: {}", peer_addr);
                });
            }
            _ = &mut shutdown_rx => {
                drop(listener);
                break;
            }
        }
    }
}

pub async fn spawn_http_service_mock(mock: Arc<HttpServiceMock>) -> (SocketAddr, oneshot::Sender<()>) {
    // Create a listener
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // Create the server loop
    tokio::spawn(async move {
        accept_connections(listener, shutdown_rx, mock).await
    });
    (addr, shutdown_tx)
}


#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;
    use http::StatusCode;

    #[tokio::test]
    async fn test_http_service_mock() -> Result<()> {
        let (mock_server, mut setup_http_server) = HttpServiceMock::new();
        let (addr, shutdown) = spawn_http_service_mock(Arc::new(mock_server)).await;

        let handler = tokio::spawn(async move {
            let (_request, result_sender) = setup_http_server.recv().await.unwrap();
            let mut headers = HeaderMap::new();
            headers.insert("sqlynx-test-header", HeaderValue::from_str("foo").unwrap());
            result_sender.send(PartialResponse::Header(StatusCode::OK, headers)).await.unwrap();
            result_sender.send(PartialResponse::BodyChunk(vec![1, 2, 3, 4])).await.unwrap();
            result_sender.send(PartialResponse::BodyChunk(vec![5, 6, 7, 8])).await.unwrap();
            drop(result_sender);
        });

        let host = format!("http://{}", addr);
        let result = reqwest::get(host)
            .await?;
        assert!(result.headers().contains_key("sqlynx-test-header"));
        assert_eq!(result.headers().get("sqlynx-test-header").unwrap(), "foo");
        let body = result
            .bytes()
            .await?;
        assert_eq!(body.to_vec(), vec![1, 2, 3, 4, 5, 6, 7, 8]);

        shutdown.send(()).unwrap();
        handler.await.unwrap();
        Ok(())
    }
}
