use std::convert::Infallible;

use http::{HeaderMap, HeaderValue};
use http_body_util::{Full, StreamBody};
use hyper::body::Body;
use hyper::body::Frame;
use hyper::{Request, Response};
use tokio_stream::wrappers::ReceiverStream;

pub enum PartialResponse {
    Header(reqwest::StatusCode, HeaderMap<HeaderValue>),
    BodyChunk(Vec<u8>)
}

pub type ResponseSender = tokio::sync::mpsc::Sender<PartialResponse>;

pub struct HttpServiceMock {
    pub setup_server_stream: tokio::sync::mpsc::Sender<(Request<Vec<u8>>, ResponseSender)>,
}

impl HttpServiceMock {
    pub async fn handle_request(&self, request: Request<Vec<u8>>) -> hyper::Result<Response<Box<dyn Body<Data = bytes::Bytes, Error = Infallible>>>> {
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
                let body: Box<dyn Body<Data = bytes::Bytes, Error = Infallible>> = Box::new(Full::new(body_data));
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
        let body: Box<dyn Body<Data = bytes::Bytes, Error = Infallible>> = Box::new(StreamBody::new(body_stream));
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

    pub fn new() -> (Self, tokio::sync::mpsc::Receiver<(Request<Vec<u8>>, ResponseSender)>) {
        let (setup_server_stream, recv_server_stream) = tokio::sync::mpsc::channel(1);
        (Self { setup_server_stream }, recv_server_stream)
    }
}


// pub async fn spawn_http_service_mock(mock: HttpServiceMock) -> (SocketAddr, oneshot::Sender<()>) {
//     // Create the listener up front so the server is immediately ready
//     // bind to port `0` so the OS finds a free port
//     let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
//     let addr = listener.local_addr().unwrap();
// 
// 
//     (addr)
// }

// 
//     let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
// 
//     loop {
//         let (stream, _) = listener.accept().await?;
//         let io = TokioIo::new(stream);
// 
//         tokio::task::spawn(async move {
//             if let Err(err) = http1::Builder::new()
//                 .preserve_header_case(true)
//                 .title_case_headers(true)
//                 .serve_connection(io, service_fn(proxy))
//                 .with_upgrades()
//                 .await
//             {
//                 println!("Failed to serve connection: {:?}", err);
//             }
//         });
//     }
// 
//     tokio::spawn(async move {
//         tonic::transport::Server::builder()
//             .add_service(service)
//             .serve_with_incoming_shutdown(
//                 tokio_stream::wrappers::TcpListenerStream::new(listener),
//                 async { drop(shutdown_rx.await) },
//             )
//             .await
//             .unwrap();
//     });
//     (addr, shutdown_tx)
// 
// }
