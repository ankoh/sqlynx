use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;
use tonic::metadata::MetadataMap;

pub enum GRPCServerStreamingResponse {
    Error(Box<dyn std::error::Error + Send + Sync>),
    Message(Vec<u8>, usize),
    Trailer(MetadataMap),
    Empty,
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
        &mut self,
        mut response: tonic::Response<tonic::Streaming<bytes::Bytes>>,
    ) -> u64 {
        let stream_id = self
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let mut metadata = MetadataMap::new();
        std::mem::swap(&mut metadata, response.metadata_mut());

        let mut streaming = response.into_inner();
        tokio::spawn(async move {
            let mut next_message_id = 0;

            let (sender, receiver) = flume::bounded::<GRPCServerStreamingResponse>(10);
            loop {
                match streaming.message().await {
                    Ok(Some(bytes)) => {
                        let message_id = next_message_id;
                        next_message_id += 1;
                        sender
                            .send_async(GRPCServerStreamingResponse::Message(
                                bytes.into(),
                                message_id,
                            ))
                            .await;
                        break;
                    }
                    Ok(None) => {
                        // Stream was closed, delete stream and return trailers
                    }
                    Err(e) => {
                        sender
                            .send_async(GRPCServerStreamingResponse::Error(Box::new(e)))
                            .await;
                        break;
                    }
                }
            }
            match streaming.trailers().await {
                Ok(Some(mut t)) => {
                    let mut trailer = MetadataMap::new();
                    std::mem::swap(&mut trailer, &mut t);
                    sender
                        .send_async(GRPCServerStreamingResponse::Trailer(trailer))
                        .await;
                }
                Ok(None) => {}
                Err(_e) => {}
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
