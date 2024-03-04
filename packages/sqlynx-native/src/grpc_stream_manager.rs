use prost::Message;
use tokio::time::timeout;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tonic::metadata::MetadataMap;

use crate::proto::salesforce_hyperdb_grpc_v1::QueryResult;
use crate::status::GrpcStreamElement;
use crate::status::Status;

#[derive(Debug)]
pub enum GrpcServerStreamEvent {
    Message(Vec<u8>),
    End(MetadataMap),
    ReadFailed(tonic::Status, GrpcStreamElement),
}

#[derive(Debug, PartialEq)]
pub enum GrpcServerStreamBatchEvent {
    StreamFailed,
    StreamFinished,
    FlushAfterClose,
    FlushAfterTimeout,
    FlushAfterBytes,
}

#[derive(Debug)]
pub struct GrpcServerStreamBatch {
    /// The event that emitted the batch
    pub event: GrpcServerStreamBatchEvent,
    /// The messages in the batch
    pub messages: Vec<Vec<u8>>,
    /// The total message bytes in the batch
    pub total_message_bytes: usize,
    /// The trailing headers (if any)
    pub trailers: Option<MetadataMap>,
}

impl Default for GrpcServerStreamBatch {
    fn default() -> Self {
        Self {
            event: GrpcServerStreamBatchEvent::StreamFailed,
            messages: Vec::default(),
            total_message_bytes: 0,
            trailers: None,
        }
    }
}

pub struct GRPCServerStream {
    /// The channel id
    #[allow(dead_code)]
    channel_id: usize,
    /// The response queue
    response_sender: tokio::sync::mpsc::Sender<GrpcServerStreamEvent>,
    /// The response queue reading
    response_receiver: Mutex<tokio::sync::mpsc::Receiver<GrpcServerStreamEvent>>,
}

#[derive(Default)]
pub struct GrpcStreamManager {
    /// The next message id
    pub next_stream_id: AtomicUsize,
    /// The server streams
    pub server_streams: RwLock<HashMap<usize, Arc<GRPCServerStream>>>,
}

impl Into<Vec<u8>> for QueryResult {
    fn into(self) -> Vec<u8> {
        self.encode_to_vec()
    }
}

impl GrpcStreamManager {
    /// Start a server stream
    #[allow(dead_code)]
    pub fn start_server_stream<T: Into<Vec<u8>> + Send + 'static>(
        self: &Arc<Self>,
        channel_id: usize,
        mut streaming: tonic::Streaming<T>,
    ) -> Result<usize, Status> {
        // Allocate an identifier for the stream
        let reg = self.clone();
        let stream_id = reg
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Register the receiver
        const STREAM_CAPACITY: usize = 10;
        let (sender, receiver) = tokio::sync::mpsc::channel(STREAM_CAPACITY);
        let stream_entry = Arc::new(GRPCServerStream {
            channel_id,
            response_sender: sender,
            response_receiver: Mutex::new(receiver),
        });
        if let Ok(mut streams) = self.server_streams.write() {
            streams.insert(stream_id, stream_entry.clone());
        }

        // Spawn the async reader
        tokio::spawn(async move {
            let mut stream_alive = true;
            while stream_alive {
                // Read the next message from the gRPC output stream
                let response = match streaming.message().await {
                    // Received bytes, forward the message as-is to receivers
                    Ok(Some(m)) => {
                        let buffer: Vec<u8> = m.into();
                        log::debug!(
                            "received message from server stream, bytes={}",
                            buffer.len()
                        );
                        GrpcServerStreamEvent::Message(buffer)
                    }
                    // Stream was closed, delete stream and return trailers
                    Ok(None) => {
                        stream_alive = false;
                        log::debug!("reached end of server stream");
                        match streaming.trailers().await {
                            Ok(Some(trailer)) => GrpcServerStreamEvent::End(trailer),
                            Ok(None) => GrpcServerStreamEvent::End(MetadataMap::new()),
                            Err(e) => {
                                GrpcServerStreamEvent::ReadFailed(e, GrpcStreamElement::Trailers)
                            }
                        }
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stream_alive = false;
                        log::warn!("reading from server stream failed with error: {}", e);
                        GrpcServerStreamEvent::ReadFailed(e, GrpcStreamElement::Message)
                    }
                };

                // Push the response into the queue
                if let Err(e) = stream_entry
                    .response_sender
                    .send(response)
                    .await
                {
                    stream_alive = false;
                    log::warn!("writing resonse to stream failed with error: {}", e);
                }
            }
        });

        // Return initial metadata
        Ok(stream_id)
    }

    /// Read from a server stream
    #[allow(dead_code)]
    pub async fn read_server_stream(
        self: &Arc<Self>,
        channel_id: usize,
        stream_id: usize,
        timeout_read_after: Duration,
        flush_batch_after: Duration,
        flush_batch_bytes: usize,
    ) -> Result<GrpcServerStreamBatch, Status> {
        let started_at = Instant::now();

        // Try to find the stream.
        // If there is none, the request might have finished already.
        let reg = self.clone();
        let stream = if let Some(streams) = reg.server_streams.read().unwrap().get(&stream_id) {
            streams.clone()
        } else {
            return Err(Status::GrpcStreamIsUnknown { channel_id, stream_id });
        };

        // Acquire the receiver lock.
        // There can only be one active reader at a time.
        let mut receiver = stream.response_receiver.lock().await;

        // Receive messages and return them in batches
        let mut batch = GrpcServerStreamBatch::default();
        loop {
            // Receive the next message from the reader
            let elapsed_since_start = started_at.elapsed();
            let response = if batch.messages.len() == 0 {
                // Initially, we check the `timeout_read_after` timeout.
                let receive_timeout = timeout_read_after.checked_sub(elapsed_since_start).unwrap_or_default();
                match timeout(receive_timeout, receiver.recv()).await {
                    Ok(Some(response)) =>  response,
                    Ok(None) => {
                        return Err(Status::GrpcStreamClosed { channel_id, stream_id });
                    },
                    Err(_) => {
                        return Err(Status::GrpcStreamReadTimedOut { channel_id, stream_id });
                    }
                }
            } else {
                // After receiving one batch, we check the `flush_batch_after` timeout.
                let receive_timeout = match flush_batch_after.checked_sub(elapsed_since_start) {
                    Some(timeout) => timeout,
                    None => {
                        batch.event = GrpcServerStreamBatchEvent::FlushAfterTimeout;
                        return Ok(batch);
                    }
                };
                match timeout(receive_timeout, receiver.recv()).await {
                    Ok(Some(response)) =>  response,
                    Ok(None) => {
                        batch.event = GrpcServerStreamBatchEvent::FlushAfterClose;
                        return Ok(batch);
                    },
                    Err(_) => {
                        batch.event = GrpcServerStreamBatchEvent::FlushAfterTimeout;
                        return Ok(batch);
                    }
                }
            };

            match response {
                // We reached the end of the stream.
                // Flush the current batch with trailers and an EOS marker.
                GrpcServerStreamEvent::End(trailers) => {
                    if let Ok(mut streams) = self.server_streams.write() {
                        streams.remove(&stream_id);
                    }
                    batch.trailers = Some(trailers);
                    batch.event = GrpcServerStreamBatchEvent::StreamFinished;
                    return Ok(batch);
                }
                // An error occurred,.
                // Throw away any intermediate messages that we held back.
                GrpcServerStreamEvent::ReadFailed(status, element) => {
                    if let Ok(mut streams) = self.server_streams.write() {
                        streams.remove(&stream_id);
                    }
                    return Err(Status::GrpcStreamReadFailed{
                        channel_id,
                        stream_id,
                        element,
                        status,
                    });
                }
                // Return the message
                GrpcServerStreamEvent::Message(m) => {
                    // Add the message to the current batch and check if we should flush
                    batch.total_message_bytes += m.len();
                    batch.messages.push(m);

                    // Flush if we hit the message size
                    if batch.total_message_bytes > flush_batch_bytes {
                        batch.event = GrpcServerStreamBatchEvent::FlushAfterBytes;
                        return Ok(batch);
                    }
                },
            }
        }
    }

    /// Cancellation is done by just dropping everything
    #[allow(dead_code)]
    pub async fn destroy_server_stream(self: &Arc<Self>, stream_id: usize) {
        // XXX Is tonic internally awaiting the finish of the server?
        if let Ok(mut streams) = self.server_streams.write() {
            streams.remove(&stream_id);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use std::collections::HashMap;
    use tokio_stream::StreamExt;

    use crate::status::Status;
    use crate::test::hyper_service_mock::{spawn_hyper_service_mock, HyperServiceMock};
    use crate::proto::salesforce_hyperdb_grpc_v1::hyper_service_client::HyperServiceClient;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_param;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_result;
    use crate::proto::salesforce_hyperdb_grpc_v1::query_result_header::Header;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryBinaryResultChunk;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryParam;
    use crate::proto::salesforce_hyperdb_grpc_v1::QueryResultSchema;
    use crate::proto::salesforce_hyperdb_grpc_v1::SqlType;
    use crate::proto::salesforce_hyperdb_grpc_v1::{sql_type, QueryResultHeader};
    use crate::proto::salesforce_hyperdb_grpc_v1::{ColumnDescription, QueryResult};

    #[tokio::test]
    async fn test_execute_query_mock() -> Result<(), Status> {
        let (mock, mut setup_execute_query) = HyperServiceMock::new();
        let (addr, shutdown) = spawn_hyper_service_mock(mock).await;
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

        // Send the results
        let (_params, result_sender) = setup_execute_query.recv().await.unwrap();
        result_sender
            .send(Ok(QueryResult {
                result: Some(query_result::Result::Header(QueryResultHeader {
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
            }))
            .await.unwrap();
        result_sender
            .send(Ok(QueryResult {
                result: Some(query_result::Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }))
            .await.unwrap();
        drop(result_sender);

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
                result: Some(query_result::Result::Header(QueryResultHeader {
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
                result: Some(query_result::Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }
        );
        shutdown.send(()).unwrap();

        Ok(())
    }

    #[tokio::test]
    async fn test_stream_reader() -> Result<(), Status> {
        // Spawn a hyper service mock
        let (mock, mut setup_execute_query) = HyperServiceMock::new();
        let (addr, shutdown) = spawn_hyper_service_mock(mock).await;
        let mut client = HyperServiceClient::connect(format!("http://{}", addr))
            .await
            .unwrap();

        // Exeute the query
        let param = QueryParam {
            query: "select 1".to_string(),
            output_format: query_param::OutputFormat::ArrowStream.into(),
            database: Vec::new(),
            params: HashMap::new(),
        };
        let res = client.execute_query(param).await.unwrap();
        let (_params, result_sender) = setup_execute_query.recv().await.unwrap();

        // Send the results
        let messages = vec![
            Ok(QueryResult {
                result: Some(query_result::Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x1, 0x2, 0x3, 0x4],
                })),
            }),
            Ok(QueryResult {
                result: Some(query_result::Result::ArrowChunk(QueryBinaryResultChunk {
                    data: vec![0x5, 0x6, 0x7, 0x8],
                })),
            }),
        ];
        for msg in messages.iter() {
            result_sender.send(msg.clone()).await.unwrap();
        }
        drop(result_sender);

        // Setup the stream manager
        let reg = Arc::new(GrpcStreamManager::default());
        reg.next_stream_id
            .fetch_add(42, std::sync::atomic::Ordering::SeqCst);
        let stream_id = reg.start_server_stream(0, res.into_inner()).unwrap();
        assert_eq!(stream_id, 42);

        // Read batched messages
        let batch = reg.read_server_stream(0, stream_id, Duration::from_secs(10), Duration::from_secs(10), 1000000).await?;
        assert_eq!(batch.messages.len(), 2);
        assert_eq!(batch.messages[0], messages[0].as_ref().unwrap().encode_to_vec());
        assert_eq!(batch.messages[1], messages[1].as_ref().unwrap().encode_to_vec());
        assert_eq!(batch.event, GrpcServerStreamBatchEvent::StreamFinished);
        assert!(!reg.server_streams.read().unwrap().contains_key(&stream_id));

        shutdown.send(()).unwrap();
        Ok(())
    }
}
