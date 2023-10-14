use crate::grpc_client::{GrpcClient, SlotId};

use super::js_promise::spawn_promise;
use neon::{prelude::*, types::buffer::TypedArray};
use tonic::Request;

pub fn export_functions(cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("grpc_create_channel", grpc_create_channel)?;
    cx.export_function("grpc_close_channel", grpc_close_channel)?;
    cx.export_function("grpc_call_unary", grpc_call_unary)?;
    cx.export_function("grpc_call_server_stream", grpc_call_server_stream)?;
    cx.export_function("grpc_call_client_stream", grpc_call_client_stream)?;
    cx.export_function("grpc_call_with_bidi_stream", grpc_call_bidi_stream)?;
    cx.export_function("grpc_read_server_stream", grpc_read_server_stream)?;
    Ok(())
}

fn grpc_create_channel(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let _url = cx.argument::<JsString>(2)?.value(&mut cx);
    spawn_promise(cx, async move { Ok(()) })
}

fn grpc_close_channel(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let _channel_id = cx.argument::<JsNumber>(2)?.value(&mut cx);
    spawn_promise(cx, async move { Ok(()) })
}

fn grpc_call_unary(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let param = cx.argument::<JsArrayBuffer>(2)?;
    let _param_owned = param.as_slice(&cx).to_vec();
    spawn_promise(cx, async move { Ok(()) })
}

fn grpc_call_server_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let channel_id = cx.argument::<JsNumber>(2)?.value(&mut cx);
    let path = cx.argument::<JsString>(3)?.value(&mut cx);
    let param = cx.argument::<JsArrayBuffer>(4)?;
    let param_owned = param.as_slice(&cx).to_vec();
    spawn_promise(cx, async move {
        let request = Request::new(param_owned);
        let stream_id = GrpcClient::call_server_stream(channel_id as SlotId, path, request).await?;
        Ok(stream_id)
    })
}

fn grpc_call_client_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let param = cx.argument::<JsArrayBuffer>(2)?;
    let _param_owned = param.as_slice(&cx).to_vec();
    spawn_promise(cx, async move { Ok(()) })
}

fn grpc_call_bidi_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let param = cx.argument::<JsArrayBuffer>(2)?;
    let _param_owned = param.as_slice(&cx).to_vec();
    spawn_promise(cx, async move { Ok(()) })
}

fn grpc_read_server_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let channel_id = cx.argument::<JsNumber>(2)?.value(&mut cx);
    let stream_id = cx.argument::<JsNumber>(3)?.value(&mut cx);
    spawn_promise(cx, async move {
        let _response =
            GrpcClient::read_server_stream(channel_id as SlotId, stream_id as SlotId).await?;
        Ok(())
    })
}
