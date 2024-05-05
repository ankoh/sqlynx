use std::convert::Infallible;
use std::net::SocketAddr;
use hyper::{Body, Request, Response, Server};
use hyper::service::{make_service_fn, service_fn};

pub struct HttpServiceMock {
    pub setup_execute_query: tokio::sync::mpsc::Sender<(QueryParam, QueryResultSender)>,
}

impl HttpServiceMock {
    pub fn new() -> (
        Self,
        tokio::sync::mpsc::Receiver<(QueryParam, QueryResultSender)>,
    ) {
        let (send, recv) = tokio::sync::mpsc::channel(1);
        (Self { setup_execute_query: send }, recv)
    }
}
