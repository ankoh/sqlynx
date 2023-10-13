use neon::prelude::*;

mod grpc_client;
mod grpc_client_api;
mod grpc_codec;
mod js_promise;
mod js_value;
mod tokio_runtime;

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    grpc_client_api::export_functions(&mut cx)?;
    Ok(())
}
