use std::io::{Read, Write};

use bytes::{Buf, BufMut};
use tonic::{codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder}, Status};

type GenericGrpcClientData = Vec<u8>;

#[derive(Debug, Clone, Default)]
struct PassthroughCodec();

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
        request: tonic::Request<GenericGrpcClientData>,
        path: tonic::codegen::http::uri::PathAndQuery,
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
        let codec = PassthroughCodec::default();
        self.inner.unary(request, path, codec).await
    }

    pub async fn call_server_streaming(
        &mut self,
        request: tonic::Request<GenericGrpcClientData>,
        path: tonic::codegen::http::uri::PathAndQuery,
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
        let codec = PassthroughCodec::default();
        self.inner.server_streaming(request, path, codec).await
    }
}

#[derive(Debug, Clone, Default)]
struct PassthroughEncoder();
#[derive(Debug, Clone, Default)]
struct PassthroughDecoder();

/// By default, Tonic uses a prost codec.
/// We use a dedicated passthrough codec that bypasses prost and writes parameter bytes as-is.
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

#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;
    use prost::Message;
    use tokio_stream::StreamExt;

    use crate::{proto::sqlynx_test::{TestServerStreamingRequest, TestServerStreamingResponse, TestUnaryRequest, TestUnaryResponse}, test::grpc_service_mock::{spawn_grpc_test_service_mock, GrpcServiceMock}};

    #[tokio::test]
    async fn test_unary() -> Result<()> {
        // Spawn a test service mock
        let (mock, mut setup_unary, mut _setup_server_streaming) = GrpcServiceMock::new();
        let (addr, shutdown) = spawn_grpc_test_service_mock(mock).await;

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
        let unary_path = tonic::codegen::http::uri::PathAndQuery::from_static(
            "/sqlynx.test.TestService/TestUnary",
        );
        let unary_param = TestUnaryRequest {
            data: "request data".to_string()
        };
        let unary_req = tonic::Request::new(unary_param.encode_to_vec());
        let unary_result = client.call_unary(unary_req, unary_path).await?;

        // Check received parameter
        let received_param = unary_call.await?;
        assert_eq!(received_param.data, "request data");

        // Check received buffer
        let received_buffer = unary_result.into_inner();
        let received_message = TestUnaryResponse::decode(received_buffer.as_slice())?;
        assert_eq!(received_message.data, "response data");

        shutdown.send(()).unwrap();
        Ok(())
    }

    #[tokio::test]
    async fn test_server_streaming() -> Result<()> {
        // Spawn a test service mock
        let (mock, mut _setup_unary, mut setup_server_streaming) = GrpcServiceMock::new();
        let (addr, shutdown) = spawn_grpc_test_service_mock(mock).await;

        // Respond single streaming response
        let streaming_call = tokio::spawn(async move {
            let (param, result_sender) = setup_server_streaming.recv().await.unwrap();
            result_sender.send(Ok(TestServerStreamingResponse {
                data: "response data".to_string()
            })).await.unwrap();
            param
        });

        // Setup the gRPC client
        let channel = tonic::transport::Endpoint::new(format!("http://{}", addr))?.connect().await?;
        let mut client = GenericGrpcClient::new(channel);

        // Call the unary test function
        let streaming_path = tonic::codegen::http::uri::PathAndQuery::from_static(
            "/sqlynx.test.TestService/TestServerStreaming",
        );
        let streaming_param = TestServerStreamingRequest {
            data: "request data".to_string()
        };
        let streaming_req = tonic::Request::new(streaming_param.encode_to_vec());
        let streaming_response = client.call_server_streaming(streaming_req, streaming_path).await?;

        // Check received parameter
        let received_param = streaming_call.await?;
        assert_eq!(received_param.data, "request data");

        // Check received buffer
        let mut stream = streaming_response.into_inner();
        while let Some(response) = stream.next().await {
            let received_message = TestUnaryResponse::decode(response.unwrap().as_slice())?;
            assert_eq!(received_message.data, "response data");
        }

        shutdown.send(()).unwrap();
        Ok(())
    }
}
