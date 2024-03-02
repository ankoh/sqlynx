struct GenericGrpcClient {
    inner: tonic::client::Grpc<tonic::transport::Channel>,
}

impl GenericGrpcClient {
    pub fn new(inner: tonic::transport::Channel) -> Self {
        let inner = tonic::client::Grpc::new(inner);
        Self { inner }
    }

    pub async fn call_unary(
        &mut self,
        request: impl tonic::IntoRequest<bytes::Bytes>,
        path: tauri::http::uri::PathAndQuery,
    ) -> std::result::Result<
        tonic::Response<bytes::Bytes>,
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
        let codec = tonic::codec::ProstCodec::default();
        let req = request.into_request();
        self.inner.unary(req, path, codec).await
    }

    pub async fn call_server_streaming(
        &mut self,
        request: impl tonic::IntoRequest<bytes::Bytes>,
        path: tauri::http::uri::PathAndQuery,
    ) -> std::result::Result<
        tonic::Response<tonic::codec::Streaming<bytes::Bytes>>,
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
        let codec = tonic::codec::ProstCodec::default();
        let req = request.into_request();
        self.inner.server_streaming(req, path, codec).await
    }
}

