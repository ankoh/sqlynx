use std::io::{Read, Write};

use bytes::{Buf, BufMut};
use tonic::{codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder}, Status};

type GenericGrpcClientData = Vec<u8>;

#[derive(Debug, Clone, Default)]
struct PassthroughCodec();
#[derive(Debug, Clone, Default)]
struct PassthroughEncoder();
#[derive(Debug, Clone, Default)]
struct PassthroughDecoder();

impl Codec for PassthroughCodec {
    type Encode = GenericGrpcClientData;
    type Decode = GenericGrpcClientData;

    type Encoder = PassthroughEncoder;
    type Decoder = PassthroughDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        PassthroughEncoder()
    }
    fn decoder(&mut self) -> Self::Decoder {
        PassthroughDecoder()
    }
}
impl Encoder for PassthroughEncoder {
    type Item = GenericGrpcClientData;
    type Error = Status;
    fn encode(&mut self, item: Self::Item, buf: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        buf.writer().write(&item)?;
        Ok(())
    }
}
impl Decoder for PassthroughDecoder {
    type Item = GenericGrpcClientData;
    type Error = Status;
    fn decode(&mut self, buf: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        let mut buffer = Vec::new();
        buf.reader().read_to_end(&mut buffer)?;
        Ok(Some(buffer))
    }
}

pub struct GenericGrpcClient {
    inner: tonic::client::Grpc<tonic::transport::Channel>,
}

impl GenericGrpcClient {
    pub fn new(inner: tonic::transport::Channel) -> Self {
        let inner = tonic::client::Grpc::new(inner);
        Self { inner }
    }

    pub async fn call_unary(
        &mut self,
        request: impl tonic::IntoRequest<GenericGrpcClientData>,
        path: tauri::http::uri::PathAndQuery,
    ) -> std::result::Result<
        tonic::Response<GenericGrpcClientData>,
        tonic::Status,
    > {
        self.inner
            .ready()
            .await
            .map_err(|e| {
                tonic::Status::new(
                    tonic::Code::Unknown,
                    format!("Service was not ready: {}", e),
                )
            })?;
        let request = request.into_request();
        let codec = PassthroughCodec::default();
        self.inner.unary(request, path, codec).await
    }

    pub async fn call_server_streaming(
        &mut self,
        request: impl tonic::IntoRequest<GenericGrpcClientData>,
        path: tauri::http::uri::PathAndQuery,
    ) -> std::result::Result<
        tonic::Response<tonic::codec::Streaming<GenericGrpcClientData>>,
        tonic::Status,
    > {
        self.inner
            .ready()
            .await
            .map_err(|e| {
                tonic::Status::new(
                    tonic::Code::Unknown,
                    format!("Service was not ready: {}", e),
                )
            })?;
        let request = request.into_request();
        let codec = tonic::codec::ProstCodec::default();
        self.inner.server_streaming(request, path, codec).await
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;
    use prost::Message;

    use crate::{proto::sqlynx_test_v1::{TestUnaryRequest, TestUnaryResponse}, test::test_service_mock::{spawn_test_service_mock, TestServiceMock}};

    #[tokio::test]
    async fn test_unary() -> Result<()> {
        // Spawn a test service mock
        let (mock, mut setup_unary, mut _setup_server_streaming) = TestServiceMock::new();
        let (addr, shutdown) = spawn_test_service_mock(mock).await;

        // Respond single unary response
        let unary_call = tokio::spawn(async move {
            let (param, result_sender) = setup_unary.recv().await.unwrap();
            result_sender.send(Ok(TestUnaryResponse {
                data: "response data".to_string()
            })).await.unwrap();
            param
        });

        // Setup the gRPC client
        let channel = tonic::transport::Endpoint::new(format!("http://{}", addr))?.connect().await?;
        let mut client = GenericGrpcClient::new(channel);

        // Call the unary test function
        let unary_path = tauri::http::uri::PathAndQuery::from_static(
            "/sqlynx.test.v1.TestService/TestUnary",
        );
        let unary_param = TestUnaryRequest {
            data: "request data".to_string()
        };
        let unary_req = unary_param.encode_to_vec();
        let unary_result = client.call_unary(unary_req, unary_path).await?;

        // Check received parameter
        let received_param = unary_call.await?;
        assert_eq!(received_param.data, "request data");

        // Check received buffer
        let received_buffer = unary_result.into_inner();
        let received_message = TestUnaryResponse::decode(bytes::Bytes::from(received_buffer))?;
        assert_eq!(received_message.data, "response data");

        shutdown.send(()).unwrap();
        Ok(())
    }

}
