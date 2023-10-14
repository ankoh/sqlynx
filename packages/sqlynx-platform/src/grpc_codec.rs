use prost::bytes::{Buf, BufMut};

// It's currently not possible to write a zero-copy codec for tonic, maybe raise this issue later.
// See here for an explanation:
// https://github.com/hyperium/tonic/pull/208#issuecomment-575218416

type Bytes = Vec<u8>;

#[derive(Default)]
pub struct ByteCodec {}
pub struct ByteEncoder {}
pub struct ByteDecoder {}

impl tonic::codec::Codec for ByteCodec {
    type Encode = Bytes;
    type Decode = Bytes;
    type Encoder = ByteEncoder;
    type Decoder = ByteDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        ByteEncoder {}
    }

    fn decoder(&mut self) -> Self::Decoder {
        ByteDecoder {}
    }
}

impl tonic::codec::Encoder for ByteEncoder {
    type Item = Bytes;
    type Error = tonic::Status;

    fn encode(
        &mut self,
        item: Self::Item,
        dst: &mut tonic::codec::EncodeBuf<'_>,
    ) -> Result<(), Self::Error> {
        dst.reserve(item.len());
        unsafe {
            let chunk = dst.chunk_mut();
            chunk.copy_from_slice(&item);
            dst.advance_mut(item.len());
        }
        Ok(())
    }
}

impl tonic::codec::Decoder for ByteDecoder {
    type Item = Bytes;
    type Error = tonic::Status;

    fn decode(
        &mut self,
        src: &mut tonic::codec::DecodeBuf<'_>,
    ) -> Result<Option<Self::Item>, Self::Error> {
        Ok(Some(src.chunk().to_vec()))
    }
}
