use prost::Message;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;
use tokio::sync::Semaphore;
use tonic::metadata::MetadataMap;

use crate::proto::salesforce_hyperdb_grpc_v1::QueryResult;

#[derive(Debug)]
pub enum GrpcServerStreamResponse {
    Message(Vec<u8>),
    End(MetadataMap),
    Error(Box<dyn std::error::Error + Send + Sync>),
    UnknownStream,
}

pub struct ResultGrpcServerStreamResponse {
    /// The response
    response: GrpcServerStreamResponse,
    /// The response id
    sequence_id: u64,
    /// The total number of received messages
    total_received: u64,
}

#[derive(Debug)]
struct OrderedGrpcServerStreamResponse {
    /// The response
    response: GrpcServerStreamResponse,
    /// The sequence id
    sequence_id: u64,
}

struct GRPCServerStream {
    /// The response queue
    response_queue: crossbeam::queue::ArrayQueue<OrderedGrpcServerStreamResponse>,
    /// The response queue reading
    response_queue_reading_permits: Semaphore,
    /// The response queue writing
    response_queue_writing_permits: Semaphore,
    /// The total number of received messages
    total_received: AtomicU64,
}

#[derive(Default)]
pub struct GrpcStreamManager {
    /// The next message id
    next_stream_id: AtomicU64,
    /// The server streams
    server_streams: RwLock<HashMap<u64, Arc<GRPCServerStream>>>,
}

impl Into<Vec<u8>> for QueryResult {
    fn into(self) -> Vec<u8> {
        self.encode_to_vec()
    }
}

impl GrpcStreamManager {
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
    pub fn start_server_stream<T: Into<Vec<u8>> + Send + 'static>(
        self: &Arc<Self>,
        mut streaming: tonic::Streaming<T>,
    ) -> anyhow::Result<u64> {
        // Allocate an identifier for the stream
        let reg = self.clone();
        let stream_id = reg
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Register the receiver
        const STREAM_CAPACITY: usize = 10;
        let stream = Arc::new(GRPCServerStream {
            response_queue: crossbeam::queue::ArrayQueue::new(STREAM_CAPACITY),
            response_queue_reading_permits: Semaphore::new(0),
            response_queue_writing_permits: Semaphore::new(STREAM_CAPACITY),
            total_received: AtomicU64::new(0),
        });
        GrpcStreamManager::register_stream(&self.server_streams, stream_id, stream.clone());

        // Spawn the async reader
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
                    Ok(Some(m)) => {
                        let buffer: Vec<u8> = m.into();
                        log::debug!(
                            "received message from server stream, bytes={}",
                            buffer.len()
                        );
                        GrpcServerStreamResponse::Message(buffer)
                    }
                    // Stream was closed, delete stream and return trailers
                    Ok(None) => {
                        stream_alive = false;
                        log::debug!("reached end of server stream");
                        match streaming.trailers().await {
                            Ok(Some(trailer)) => GrpcServerStreamResponse::End(trailer),
                            Ok(None) => GrpcServerStreamResponse::End(MetadataMap::new()),
                            Err(e) => {
                                log::warn!("reading trailers failed with error: {}", e);
                                GrpcServerStreamResponse::Error(Box::new(e))
                            }
                        }
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stream_alive = false;
                        log::warn!("reading from server stream failed with error: {}", e);
                        GrpcServerStreamResponse::Error(Box::new(e))
                    }
                };
                stream
                    .total_received
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

                // Push the response into the queue
                if let Ok(permit) = stream.response_queue_writing_permits.acquire().await {
                    permit.forget();
                    stream
                        .response_queue
                        .push(OrderedGrpcServerStreamResponse {
                            response,
                            sequence_id,
                        })
                        .unwrap();
                    stream.response_queue_reading_permits.add_permits(1);
                } else {
                    stream_alive = false;
                }
            }
        });

        // Return initial metadata
        Ok(stream_id)
    }

    /// Read from a server stream
    pub async fn read_server_stream(
        self: &Arc<Self>,
        stream_id: u64,
    ) -> ResultGrpcServerStreamResponse {
        // Try to find the stream.
        // If there is none, the request might have finished already.
        let reg = self.clone();
        let stream = match GrpcStreamManager::find_stream(&reg.server_streams, stream_id) {
            Some(stream) => stream,
            None => {
                return ResultGrpcServerStreamResponse {
                    response: GrpcServerStreamResponse::UnknownStream,
                    sequence_id: 0,
                    total_received: 0,
                }
            }
        };
        let total_received = stream
            .total_received
            .load(std::sync::atomic::Ordering::Acquire);

        // Receive the next message from the stream
        let queued = if let Ok(permit) = stream.response_queue_reading_permits.acquire().await {
            permit.forget();
            let queued = stream.response_queue.pop().unwrap();
            stream.response_queue_writing_permits.add_permits(1);
            queued
        } else {
            // XXX Closed?
            return ResultGrpcServerStreamResponse {
                response: GrpcServerStreamResponse::UnknownStream,
                sequence_id: 0,
                total_received: 0,
            };
        };

        // Cleanup the stream if we reached the end
        match queued.response {
            GrpcServerStreamResponse::End(_) | GrpcServerStreamResponse::Error(_) => {
                GrpcStreamManager::remove_stream(&self.server_streams, stream_id)
            }
            _ => (),
        };
        return ResultGrpcServerStreamResponse {
            response: queued.response,
            sequence_id: queued.sequence_id,
            total_received,
        };
    }

    /// Read from a server stream
    pub async fn finish_server_stream(self: &Arc<Self>, stream_id: u64) -> () {
        GrpcStreamManager::remove_stream(&self.server_streams, stream_id)
    }
}

#[cfg(test)]
mod test {
    use super::*;
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
    async fn test_execute_query_mock() {
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

    #[tokio::test]
    async fn test_stream_reader() {
        let messages = vec![
            Ok(QueryResult {
                result: Some(Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }),
            Ok(QueryResult {
                result: Some(Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x5, 0x6, 0x7, 0x8],
                })),
            }),
        ];
        let mut mock = HyperExecuteQueryMock::default();
        mock.returns_messages = messages.clone();
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
        let res = client.execute_query(param).await.unwrap();
        let stream = res.into_inner();

        let reg = Arc::new(GrpcStreamManager::default());
        reg.next_stream_id
            .fetch_add(42, std::sync::atomic::Ordering::SeqCst);
        let stream_id = reg.start_server_stream(stream).unwrap();
        assert_eq!(stream_id, 42);

        // Read batches
        for i in 0..2 {
            let res = reg.read_server_stream(stream_id).await;
            let msg = match res.response {
                GrpcServerStreamResponse::Message(m) => m,
                _ => panic!("{:?}", res.response),
            };
            assert_eq!(res.sequence_id, i);
            assert_eq!(msg, messages[i as usize].as_ref().unwrap().encode_to_vec());
        }

        // Read the end
        let res = reg.read_server_stream(stream_id).await;
        let _trailer = match res.response {
            GrpcServerStreamResponse::End(m) => m,
            _ => panic!("{:?}", res.response),
        };
        assert_eq!(res.sequence_id, 2);

        shutdown.send(()).unwrap();
    }
}
