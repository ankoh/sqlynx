use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;
use tonic::metadata::MetadataMap;

pub enum GrpcServerStreamingResponse {
    Message(Vec<u8>),
    End(MetadataMap),
    Error(Box<dyn std::error::Error + Send + Sync>),
    NoStream,
}

pub struct ResultGrpcServerStreamingResponse {
    /// The response
    response: GrpcServerStreamingResponse,
    /// The response id
    sequence_id: u64,
    /// The total number of received messages
    total_received: u64,
}

struct OrderedGrpcServerStreamingResponse {
    /// The response
    response: GrpcServerStreamingResponse,
    /// The sequence id
    sequence_id: u64,
}

struct GRPCServerStreamingRequest {
    /// The output receiver
    receiver: flume::Receiver<OrderedGrpcServerStreamingResponse>,
    /// The total number of received messages
    total_received: AtomicU64,
}

#[derive(Default)]
pub struct GrpcStreamRegistry {
    /// The next message id
    next_stream_id: AtomicU64,
    /// The server streams
    server_streams: RwLock<HashMap<u64, Arc<GRPCServerStreamingRequest>>>,
}

impl GrpcStreamRegistry {
    /// Register a streaming request
    fn register_stream<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64, req: Arc<T>) {
        if let Ok(mut requests) = dict.write() {
            requests.insert(id, req.clone());
        }
    }
    /// Remove a request
    fn remove_stream<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64) {
        if let Ok(mut requests) = dict.write() {
            requests.remove(&id);
        }
    }
    /// Find a request
    fn find_stream<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64) -> Option<Arc<T>> {
        if let Ok(requests) = dict.read() {
            requests.get(&id).cloned()
        } else {
            None
        }
    }

    /// Start a server stream
    pub fn start_server_stream(
        self: Arc<Self>,
        mut request: tonic::Response<tonic::Streaming<bytes::Bytes>>,
    ) -> anyhow::Result<MetadataMap> {
        // Allocate an identifier for the stream
        let stream_id = self
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Setup channel for spmc queue
        const STREAM_CAPACITY: usize = 10;
        let (sender, receiver) =
            flume::bounded::<OrderedGrpcServerStreamingResponse>(STREAM_CAPACITY);

        // Move the initial metadata out and send insert them in the channel
        let mut metadata = MetadataMap::new();
        std::mem::swap(&mut metadata, request.metadata_mut());

        // Register the receiver
        let entry = Arc::new(GRPCServerStreamingRequest {
            receiver,
            total_received: AtomicU64::new(0),
        });
        GrpcStreamRegistry::register_stream(&self.server_streams, stream_id, entry.clone());

        // Spawn the async reader
        let mut streaming = request.into_inner();
        tokio::spawn(async move {
            let mut next_sequence_id = 0;

            let mut stream_alive = true;
            while stream_alive {
                // Get next sequence id
                let sequence_id = next_sequence_id;
                next_sequence_id += 1;

                // Read the next message from the gRPC output stream
                let response = match streaming.message().await {
                    // Received bytes, forward the message as-is to receivers
                    Ok(Some(bytes)) => {
                        log::debug!("received message from server stream, bytes={}", bytes.len());
                        GrpcServerStreamingResponse::Message(bytes.into())
                    }
                    // Stream was closed, delete stream and return trailers
                    Ok(None) => {
                        stream_alive = false;
                        log::debug!("reached end of server stream");
                        match streaming.trailers().await {
                            Ok(Some(trailer)) => GrpcServerStreamingResponse::End(trailer),
                            Ok(None) => GrpcServerStreamingResponse::End(MetadataMap::new()),
                            Err(e) => {
                                log::warn!("reading trailers failed with error: {}", e);
                                GrpcServerStreamingResponse::Error(Box::new(e))
                            }
                        }
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stream_alive = false;
                        log::warn!("reading from server stream failed with error: {}", e);
                        GrpcServerStreamingResponse::Error(Box::new(e))
                    }
                };
                entry
                    .total_received
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

                // Forward the response to the receivers
                if let Err(e) = sender
                    .send_async(OrderedGrpcServerStreamingResponse {
                        response,
                        sequence_id,
                    })
                    .await
                {
                    stream_alive = false;
                    log::warn!("insert response into channel failed with error: {}", e);
                }
            }

            // Remove the stream when we're done.
            // Note that we're cleaning up the stream early.
            // There might still be arriving read calls that will receive an empty response by default.
            GrpcStreamRegistry::remove_stream(&self.server_streams, stream_id)
        });

        // Return initial metadata
        Ok(metadata)
    }

    /// Read from a server stream
    pub async fn read_server_stream(
        self: Arc<Self>,
        stream_id: u64,
    ) -> ResultGrpcServerStreamingResponse {
        // Try to find the stream.
        // If there is none, the request might have finished already.
        let stream = match GrpcStreamRegistry::find_stream(&self.server_streams, stream_id) {
            Some(stream) => stream,
            None => {
                return ResultGrpcServerStreamingResponse {
                    response: GrpcServerStreamingResponse::NoStream,
                    sequence_id: 0,
                    total_received: 0,
                }
            }
        };
        let total_received = stream
            .total_received
            .load(std::sync::atomic::Ordering::Acquire);
        // Receive the next message from the stream
        match stream.receiver.recv_async().await {
            Ok(buffered) => ResultGrpcServerStreamingResponse {
                response: buffered.response,
                sequence_id: buffered.sequence_id,
                total_received,
            },
            Err(e) => {
                // XXX Closing probably returns an error as well?
                log::warn!("{}", e);
                ResultGrpcServerStreamingResponse {
                    response: GrpcServerStreamingResponse::Error(Box::new(e)),
                    sequence_id: total_received,
                    total_received,
                }
            }
        }
    }
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;
    use tokio_stream::StreamExt;

    use crate::hyper_service_mocks::{spawn_test_hyper_service, HyperExecuteQueryMock};
    use crate::proto::salesforce_hyperdb_grpc_v1::hyper_service_client::HyperServiceClient;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_param;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_result::Result;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_result_header::Header;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryBinaryResultChunk;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryParam;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryResultSchema;
    use crate::proto::salesforce_hyperdb_grpc_v1::SqlType;
    use crate::proto::salesforce_hyperdb_grpc_v1::{sql_type, QueryResultHeader};
    use crate::proto::salesforce_hyperdb_grpc_v1::{ColumnDescription, QueryResult};

    #[tokio::test]
    async fn test_mock() {
        let mut mock = HyperExecuteQueryMock::default();
        mock.returns_messages = vec![
            Ok(QueryResult {
                result: Some(Result::Header(QueryResultHeader {
                    header: Some(Header::Schema(QueryResultSchema {
                        column: vec![ColumnDescription {
                            name: "foo".to_string(),
                            r#type: Some(SqlType {
                                tag: sql_type::TypeTag::HyperBool.into(),
                                modifier: None,
                            }),
                        }],
                    })),
                })),
            }),
            Ok(QueryResult {
                result: Some(Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }),
        ];
        let (addr, shutdown) = spawn_test_hyper_service(mock).await;
        let mut client = HyperServiceClient::connect(format!("http://{}", addr))
            .await
            .unwrap();

        let param = QueryParam {
            query: "select 1".to_string(),
            output_format: query_param::OutputFormat::ArrowStream.into(),
            database: Vec::new(),
            params: HashMap::new(),
        };
        let result = client.execute_query(param).await.unwrap();

        let mut stream = result.into_inner();
        let mut results = Vec::new();
        while let Some(item) = stream.next().await {
            assert!(item.is_ok());
            results.push(item.unwrap());
        }
        assert_eq!(results.len(), 2);
        assert!(results[0].result.is_some());
        assert_eq!(
            &results[0],
            &QueryResult {
                result: Some(Result::Header(QueryResultHeader {
                    header: Some(Header::Schema(QueryResultSchema {
                        column: vec![ColumnDescription {
                            name: "foo".to_string(),
                            r#type: Some(SqlType {
                                tag: sql_type::TypeTag::HyperBool.into(),
                                modifier: None,
                            }),
                        }],
                    })),
                })),
            }
        );
        assert!(results[1].result.is_some());
        assert_eq!(
            &results[1],
            &QueryResult {
                result: Some(Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }
        );
        shutdown.send(()).unwrap();
    }
}
