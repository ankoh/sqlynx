use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;
use tonic::metadata::MetadataMap;

pub enum GrpcServerStreamingResponse {
    InitialMetadata(MetadataMap),
    Message(Vec<u8>),
    TrailingMetadata(MetadataMap),
    Empty,
    Error(Box<dyn std::error::Error + Send + Sync>),
}

pub struct ResultGrpcServerStreamingResponse {
    /// The response
    response: GrpcServerStreamingResponse,
    /// The response id
    response_id: u64,
    /// The total number of received messages
    total_received: u64,
}

struct BufferedGrpcServerStreamingResponse {
    /// The response
    response: GrpcServerStreamingResponse,
    /// The response id
    response_id: u64,
}

pub struct GRPCServerStreamingRequest {
    /// The output receiver
    pub receiver: flume::Receiver<BufferedGrpcServerStreamingResponse>,
}

#[derive(Default)]
pub struct GrpcStreamRegistry {
    /// The next event id
    next_response_id: AtomicU64,
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
    pub async fn start_server_stream(
        self: Arc<Self>,
        mut response: tonic::Response<tonic::Streaming<bytes::Bytes>>,
    ) -> u64 {
        // Allocate an identifier for the stream
        let stream_id = self
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Setup channel for spmc queue
        const STREAM_CAPACITY: usize = 10;
        let (sender, receiver) =
            flume::bounded::<BufferedGrpcServerStreamingResponse>(STREAM_CAPACITY);

        // Move the initial metadata out and send insert them in the channel
        let mut metadata = MetadataMap::new();
        std::mem::swap(&mut metadata, response.metadata_mut());
        assert!(
            STREAM_CAPACITY > 1,
            "initial metadata is pushed into the channel without active receier and must not block"
        );
        // Allocate an identifier for the response
        let response_id = self
            .next_response_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Send the initial metadata
        if let Err(e) = sender
            .send_async(BufferedGrpcServerStreamingResponse {
                response: GrpcServerStreamingResponse::InitialMetadata(metadata),
                response_id,
            })
            .await
        {
            log::debug!(
                "inserting initial metadata into the channel failed with error: {}",
                e
            );
        }

        // Register the receiver
        let request = Arc::new(GRPCServerStreamingRequest { receiver });
        GrpcStreamRegistry::register_stream(&self.server_streams, stream_id, request);

        // Spawn the async reader
        let mut streaming = response.into_inner();
        tokio::spawn(async move {
            let mut stream_alive = true;
            while stream_alive {
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
                        GrpcServerStreamingResponse::Empty
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stream_alive = false;
                        log::warn!("reading from server stream failed with error: {}", e);
                        GrpcServerStreamingResponse::Error(Box::new(e))
                    }
                };
                // Allocate an identifier for the response
                let response_id = self
                    .next_response_id
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

                // Forward the response to the receivers
                if let Err(e) = sender
                    .send_async(BufferedGrpcServerStreamingResponse {
                        response,
                        response_id,
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
        stream_id
    }

    /// Read from a server stream
    pub async fn read_server_stream(self: Arc<Self>, id: u64) -> ResultGrpcServerStreamingResponse {
        // Get the response id
        let total_received = self
            .next_response_id
            .load(std::sync::atomic::Ordering::SeqCst);

        // Try to find the stream.
        // If there is none, the request might have finished already.
        // Return an empty message instead.
        let stream = match GrpcStreamRegistry::find_stream(&self.server_streams, id) {
            Some(stream) => stream,
            None => {
                return ResultGrpcServerStreamingResponse {
                    response: GrpcServerStreamingResponse::Empty,
                    response_id: total_received,
                    total_received,
                }
            }
        };
        // Receive the next message from the stream
        match stream.receiver.recv_async().await {
            Ok(buffered) => ResultGrpcServerStreamingResponse {
                response: buffered.response,
                response_id: buffered.response_id,
                total_received,
            },
            Err(e) => {
                // XXX Closing probably returns an error as well?
                log::warn!("{}", e);
                ResultGrpcServerStreamingResponse {
                    response: GrpcServerStreamingResponse::Empty,
                    response_id: total_received,
                    total_received,
                }
            }
        }
    }
}
