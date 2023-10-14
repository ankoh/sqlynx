use neon::{prelude::*, types::buffer::TypedArray};

pub trait AsJsValue {
    fn as_jsvalue<'a, C: Context<'a>>(self, _: &mut C) -> Handle<'a, JsValue>;
}

impl AsJsValue for () {
    fn as_jsvalue<'a, C: Context<'a>>(self, c: &mut C) -> Handle<'a, JsValue> {
        c.undefined().upcast()
    }
}

impl AsJsValue for usize {
    fn as_jsvalue<'a, C: Context<'a>>(self, c: &mut C) -> Handle<'a, JsValue> {
        c.number(self as f64).upcast()
    }
}

impl AsJsValue for Vec<u8> {
    fn as_jsvalue<'a, C: Context<'a>>(self, c: &mut C) -> Handle<'a, JsValue> {
        let mut array = JsArrayBuffer::new(c, self.len() as usize).unwrap();
        array.as_mut_slice(c).copy_from_slice(&self);
        array.upcast()
    }
}

impl<V> AsJsValue for Vec<V>
where
    V: AsJsValue,
{
    fn as_jsvalue<'a, C: Context<'a>>(mut self, c: &mut C) -> Handle<'a, JsValue> {
        let array = JsArray::new(c, self.len() as u32);
        for (i, v) in self.drain(..).enumerate() {
            let v = v.as_jsvalue(c);
            array.set(c, i as u32, v).ok();
        }
        array.upcast()
    }
}

impl<V> AsJsValue for Option<V>
where
    V: AsJsValue,
{
    fn as_jsvalue<'a, C: Context<'a>>(self, c: &mut C) -> Handle<'a, JsValue> {
        match self {
            Some(v) => v.as_jsvalue(c).upcast(),
            None => c.null().upcast(),
        }
    }
}
