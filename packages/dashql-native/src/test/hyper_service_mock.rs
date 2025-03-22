use crate::buffers::salesforce_hyperdb_grpc_v1::{
    hyper_service_server::{HyperService, HyperServiceServer},
    QueryParam, QueryResult,
};
use std::{net::SocketAddr, pin::Pin};
use tokio::sync::oneshot;
use tokio_stream::{wrappers::ReceiverStream, Stream};
use tonic::Status;

pub type QueryResultSender = tokio::sync::mpsc::Sender<Result<QueryResult, tonic::Status>>;

pub struct HyperServiceMock {
    pub setup_execute_query: tokio::sync::mpsc::Sender<(QueryParam, QueryResultSender)>,
}

impl HyperServiceMock {
    pub fn new() -> (
        Self,
        tokio::sync::mpsc::Receiver<(QueryParam, QueryResultSender)>,
    ) {
        let (send, recv) = tokio::sync::mpsc::channel(1);
        (Self { setup_execute_query: send }, recv)
    }
}

type ExecuteQueryResponseStream = Pin<Box<dyn Stream<Item = Result<QueryResult, Status>> + Send>>;

#[tonic::async_trait]
impl HyperService for HyperServiceMock {
    type ExecuteQueryStream = ExecuteQueryResponseStream;

    async fn execute_query(
        &self,
        request: tonic::Request<QueryParam>,
    ) -> Result<tonic::Response<Self::ExecuteQueryStream>, tonic::Status> {
        // Setup a channel for sending results
        let (result_sender, receive) = tokio::sync::mpsc::channel(10);
        let test_setup = self.setup_execute_query.clone();

        // Pass the result_sender back to the test, together with the request params
        let params = request.into_inner();
        test_setup.send((params, result_sender)).await.unwrap();

        // Wire up a receiver stream to the gRPC output
        let out = ReceiverStream::new(receive);
        Ok(tonic::Response::new(
            Box::pin(out) as Self::ExecuteQueryStream
        ))
    }
}

pub async fn spawn_hyper_service_mock(mock: HyperServiceMock) -> (SocketAddr, oneshot::Sender<()>) {
    let service = HyperServiceServer::new(mock);

    // create the listener up front so the server is immediately ready
    // bind to port `0` so the OS finds a free port
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(service)
            .serve_with_incoming_shutdown(
                tokio_stream::wrappers::TcpListenerStream::new(listener),
                async { drop(shutdown_rx.await) },
            )
            .await
            .unwrap();
    });
    (addr, shutdown_tx)
}
