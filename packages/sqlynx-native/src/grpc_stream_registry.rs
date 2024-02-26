use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;
use tonic::metadata::MetadataMap;

pub enum GRPCServerStreamingResponse {
    InitialMetadata(MetadataMap),
    Message(Vec<u8>, usize),
    TrailingMetadata(MetadataMap),
    Empty,
    Error(Box<dyn std::error::Error + Send + Sync>),
}

pub struct GRPCServerStreamingRequest {
    /// The output receiver
    pub receiver: flume::Receiver<GRPCServerStreamingResponse>,
}

pub struct GrpcStreamRegistry {
    /// The next message id
    next_stream_id: AtomicU64,
    /// The server streams
    server_streams: RwLock<HashMap<u64, Arc<GRPCServerStreamingRequest>>>,
}

impl GrpcStreamRegistry {
    /// Insert a request
    fn insert_stream<T>(dict: &mut RwLock<HashMap<u64, Arc<T>>>, id: u64, req: Arc<T>) {
        if let Ok(mut requests) = dict.write() {
            requests.insert(id, req.clone());
        }
    }
    /// Remove a request
    fn remove_stream<T>(dict: &mut RwLock<HashMap<u64, Arc<T>>>, id: u64) {
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
        registry: Arc<Self>,
        mut response: tonic::Response<tonic::Streaming<bytes::Bytes>>,
    ) -> u64 {
        // Allocate an identifier for the stream
        let stream_id = registry
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Setup channel for spmc queue
        const STREAM_CAPACITY: usize = 10;
        let (sender, receiver) = flume::bounded::<GRPCServerStreamingResponse>(STREAM_CAPACITY);

        // Move the initial metadata out and send them out
        let mut metadata = MetadataMap::new();
        std::mem::swap(&mut metadata, response.metadata_mut());
        assert!(
            STREAM_CAPACITY > 1,
            "initial metadata is pushed into the channel without active receier and must not block"
        );
        sender
            .send_async(GRPCServerStreamingResponse::InitialMetadata(metadata))
            .await
            .ok(); // XXX

        // Spawn the async reader
        let mut streaming = response.into_inner();
        tokio::spawn(async move {
            let mut next_message_id = 0;

            loop {
                let mut stop = false;

                // Read the next message from the server stream
                let response = match streaming.message().await {
                    // Received bytes, forward the message as-is to receivers
                    Ok(Some(bytes)) => {
                        let message_id = next_message_id;
                        next_message_id += 1;
                        log::debug!("received message from server stream, bytes={}", bytes.len());
                        GRPCServerStreamingResponse::Message(bytes.into(), message_id)
                    }
                    // Stream was closed, delete stream and return trailers
                    Ok(None) => {
                        stop = true;
                        log::debug!("reached end of server stream");
                        GRPCServerStreamingResponse::Empty
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stop = true;
                        log::debug!("reading from server stream failed with error: {}", e);
                        GRPCServerStreamingResponse::Error(Box::new(e))
                    }
                };

                // Forward the response to the receivers
                sender.send_async(response).await; // XXX

                // Should we stop reading?
                if stop {
                    break;
                }
            }
        });
        stream_id
    }

    /// Read from a server stream
    pub async fn read_server_stream(&mut self, id: u64) -> GRPCServerStreamingResponse {
        let req = match GrpcStreamRegistry::find_stream(&mut self.server_streams, id) {
            Some(req) => req,
            None => return GRPCServerStreamingResponse::Empty,
        };
        match req.receiver.recv_async().await {
            Ok(response) => response,
            Err(e) => {
                log::warn!("{}", e);
                GRPCServerStreamingResponse::Empty
            }
        }
    }
}
