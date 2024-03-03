use axum::routing::{delete, get, post};
use axum::Router;
use axum::extract::{Path, Request};
use axum::http::StatusCode;
use lazy_static::lazy_static;

use crate::grpc_proxy::GrpcProxy;

lazy_static! {
    static ref GRPC_PROXY: GrpcProxy = GrpcProxy::default();
}

async fn create_channel(_req: Request) -> Result<(), (StatusCode, String)> {
    Ok(())
}

async fn delete_channel(Path(_channel_id): Path<usize>, _req: Request) -> Result<(), (StatusCode, String)> {
    Ok(())
}

async fn call_unary(Path(_channel_id): Path<usize>, _req: Request) -> Result<Vec<u8>, (StatusCode, String)> {
    Ok(Vec::new())
}

async fn start_server_stream(Path(_channel_id): Path<usize>, _req: Request) -> Result<(), (StatusCode, String)> {
    Ok(())
}

async fn read_server_stream(Path(_channel_id): Path<usize>, Path(_stream_id): Path<usize>, _req: Request) -> Result<Vec<u8>, (StatusCode, String)> {
    Ok(Vec::new())
}

async fn delete_server_stream(Path(_channel_id): Path<usize>, Path(_stream_id): Path<usize>, _req: Request) -> Result<(), (StatusCode, String)> {
    Ok(())
}

pub fn create_grpc_router() -> axum::Router<()> {
    Router::new()
        .route("/channels", post(create_channel))
        .route("/channel/:channel_id", delete(delete_channel))
        .route("/channel/:channel_id/unary", post(call_unary))
        .route("/channel/:channel_id/streams", post(start_server_stream))
        .route("/channel/:channel_id/stream/:stream_id", get(read_server_stream))
        .route("/channel/:channel_id/stream/:stream_id", delete(delete_server_stream))
}
