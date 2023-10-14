use neon::prelude::*;
use std::future::Future;

use super::js_value::AsJsValue;
use super::tokio_runtime::scheduler;

pub fn spawn_promise<'a, Body, Value>(
    mut cx: FunctionContext<'a>,
    f: Body,
) -> JsResult<'a, JsUndefined>
where
    Value: AsJsValue + Send + 'static,
    Body: Future<Output = Result<Value, String>> + Send + 'static,
{
    let resolve = cx.argument::<JsFunction>(0)?.root(&mut cx);
    let reject = cx.argument::<JsFunction>(1)?.root(&mut cx);
    let channel = cx.channel();
    scheduler(&mut cx)?.spawn(async move {
        match f.await {
            Ok(value) => {
                channel.send(move |mut cx| {
                    let args = vec![value.as_jsvalue(&mut cx)];
                    let this = cx.undefined();
                    resolve.into_inner(&mut cx).call(&mut cx, this, args)?;
                    Ok(())
                });
            }
            Err(e) => {
                channel.send(|mut cx| {
                    let args = vec![cx.string(e).upcast()];
                    let this = cx.undefined();
                    reject
                        .into_inner(&mut cx)
                        .call(&mut cx, this, args)
                        .unwrap();
                    Ok(())
                });
            }
        }
    });
    Ok(cx.undefined())
}
