use crate::proto::salesforce_hyperdb_grpc_v1::{
    hyper_service_server::{HyperService, HyperServiceServer},
    QueryParam, QueryResult,
};
use std::sync::Mutex;
use std::{net::SocketAddr, pin::Pin};
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_stream::{wrappers::ReceiverStream, Stream};
use tonic::Status;

#[derive(Default)]
pub struct HyperExecuteQueryMock {
    pub received_params: Mutex<Option<QueryParam>>,
    pub returns_messages: Vec<Result<QueryResult, tonic::Status>>,
}

type ExecuteQueryResponseStream = Pin<Box<dyn Stream<Item = Result<QueryResult, Status>> + Send>>;

#[tonic::async_trait]
impl HyperService for HyperExecuteQueryMock {
    type ExecuteQueryStream = ExecuteQueryResponseStream;

    async fn execute_query(
        &self,
        request: tonic::Request<QueryParam>,
    ) -> Result<tonic::Response<Self::ExecuteQueryStream>, tonic::Status> {
        {
            let mut params = self.received_params.lock().unwrap();
            params.replace(request.get_ref().clone());
        }
        let (tx, rx) = mpsc::channel(10);
        let messages = self.returns_messages.clone();
        tokio::spawn(async move {
            for msg in messages {
                tx.send(msg.clone()).await.expect("tx ok");
            }
        });
        let out = ReceiverStream::new(rx);
        Ok(tonic::Response::new(
            Box::pin(out) as Self::ExecuteQueryStream
        ))
    }
}

pub async fn spawn_test_hyper_service<S>(service_impl: S) -> (SocketAddr, oneshot::Sender<()>)
where
    S: HyperService,
{
    let service = HyperServiceServer::new(service_impl);

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
