use once_cell::sync::OnceCell;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::Mutex;
use tonic::codegen::http::uri::PathAndQuery;
use tonic::metadata::MetadataMap;
use tonic::Request;
use tonic::Status;

use crate::grpc_codec::ByteCodec;

pub type SlotId = usize;

#[derive(Default)]
pub struct GrpcClient {
    channels: Vec<Option<GrpcClientChannel>>,
}

struct GrpcClientChannel {
    client: tonic::client::Grpc<tonic::transport::Channel>,
    server_streams: Vec<Option<Arc<Mutex<GrpcServerStream>>>>,
}

pub enum GrpcServerStreamEvent {
    StreamHeader(MetadataMap),
    StreamMessage(Vec<u8>),
    StreamTrailers(MetadataMap),
    StreamClosed(Option<Status>),
}

pub struct GrpcServerStreamResponse {
    _events: Vec<GrpcServerStreamEvent>,
    _done: bool,
}

struct GrpcServerStream {
    receiver: mpsc::Receiver<GrpcServerStreamEvent>,
}

/// Helper to allocate an element in a slot vector.
/// We allocate slots in vectors to return small and efficient handles to the user.
fn alloc_slot<'a, V>(elements: &'a mut Vec<Option<V>>) -> (SlotId, &'a mut Option<V>) {
    for i in 0..elements.len() {
        if elements[i].is_none() {
            return (i, &mut elements[i]);
        }
    }
    elements.push(None);
    let id = elements.len() - 1;
    return (id, &mut elements[id]);
}

/// Free the slot and shrink the vector (if possible)
fn free_slot<'a, V>(elements: &'a mut Vec<Option<V>>, id: SlotId) {
    elements[id] = None;
    if id == (elements.len() - 1) {
        elements.pop();
        while elements.last().is_none() {
            elements.pop();
        }
    }
}

impl GrpcServerStream {
    fn create() -> (Self, mpsc::Sender<GrpcServerStreamEvent>) {
        let (sender, receiver) = mpsc::channel(10);
        let query = Self { receiver: receiver };
        (query, sender)
    }
}

impl GrpcClient {
    /// Get the global service
    pub fn get() -> &'static Mutex<GrpcClient> {
        static CLIENT: OnceCell<Mutex<GrpcClient>> = OnceCell::new();
        CLIENT.get_or_init(|| Mutex::new(GrpcClient::default()))
    }

    /// Execute a query
    pub async fn call_server_stream(
        channel_id: SlotId,
        path: String,
        request: Request<Vec<u8>>,
    ) -> Result<SlotId, String> {
        let (mut client, stream_id, sender) = {
            // Resolve the channel
            let mut client = GrpcClient::get().lock().await;
            let channel = client.channels[channel_id]
                .as_mut()
                .ok_or_else(|| format!("failed to resolve channel with id {}", channel_id))?;
            let client = channel.client.clone();

            // Create the stream
            let (stream_id, stream_out) = alloc_slot(&mut channel.server_streams);
            let (stream, sender) = GrpcServerStream::create();
            stream_out.replace(Arc::new(Mutex::new(stream)));
            (client, stream_id, sender)
        };

        // Execute the query
        let mut response = match {
            // Wait until the server is ready
            client
                .ready()
                .await
                .map_err(|e| format!("Service was not ready: {}", e.to_string()))?;
            // Create the raw byte codec that bypasses the protobuf deserialisation
            let codec = ByteCodec::default();
            // Create RPC path
            let rpc_path = PathAndQuery::from_str(&path).map_err(|e| e.to_string())?;
            // Send the request
            let response = client
                .server_streaming(request, rpc_path, codec)
                .await
                .map_err(|e| e.to_string())?;
            // Return the response
            Ok(response)
        } {
            Ok(s) => s,
            Err(e) => {
                // The query execution failed, free the slot
                let mut client = GrpcClient::get().lock().await;
                let channel = client.channels[channel_id].as_mut().unwrap();
                free_slot(&mut channel.server_streams, stream_id);
                return Err(e);
            }
        };

        // Spawn the reader to poll the query result
        tokio::spawn(async move {
            // Send metadata message
            let metadata = std::mem::replace(response.metadata_mut(), MetadataMap::default());
            sender
                .send(GrpcServerStreamEvent::StreamHeader(metadata))
                .await
                .ok();

            let mut stream = response.into_inner();
            loop {
                // Read a message or cancel if the receiver was closed
                match tokio::select! {
                    v = stream.message() => { v }
                    _ = sender.closed() => break
                } {
                    // Received a query result, send over channel
                    Ok(Some(r)) => {
                        if let Err(_) = sender.send(GrpcServerStreamEvent::StreamMessage(r)).await {
                            // Do nothing if the receiver side was closed
                            debug_assert!(sender.is_closed());
                            break;
                        }
                        // Otherwise continue with next message
                    }
                    // Reached EOS, check any trailers
                    Ok(None) => {
                        match stream.trailers().await {
                            // Received trailers send before closing
                            Ok(Some(trailers)) => {
                                sender
                                    .send(GrpcServerStreamEvent::StreamTrailers(trailers))
                                    .await
                                    .ok();
                                sender
                                    .send(GrpcServerStreamEvent::StreamClosed(None))
                                    .await
                                    .ok();
                            }
                            // No trailers present, just send OK
                            Ok(None) => {
                                sender
                                    .send(GrpcServerStreamEvent::StreamClosed(None))
                                    .await
                                    .ok();
                            }
                            // Error while reading trailers, send as stream error
                            Err(e) => {
                                sender
                                    .send(GrpcServerStreamEvent::StreamClosed(Some(e)))
                                    .await
                                    .ok();
                            }
                        };
                        break;
                    }
                    // Received error, forward as stream error
                    Err(e) => {
                        sender
                            .send(GrpcServerStreamEvent::StreamClosed(Some(e)))
                            .await
                            .ok();
                        break;
                    }
                }
            }
        });
        Ok(stream_id)
    }

    /// Read from a query result stream
    pub async fn read_server_stream(
        channel_id: SlotId,
        stream_id: SlotId,
    ) -> Result<GrpcServerStreamResponse, String> {
        // Resolve the stream
        let stream_mtx = {
            let mut client = GrpcClient::get().lock().await;
            let channel = client.channels[channel_id]
                .as_mut()
                .ok_or_else(|| format!("failed to resolve channel with id {}", channel_id))?;
            let stream = channel.server_streams[stream_id]
                .as_mut()
                .ok_or_else(|| format!("failed to resolve stream with id {}", stream_id))?;
            stream.clone()
        };
        let mut stream = stream_mtx.lock().await;

        // Fetch all buffered results from the channel without waiting
        let mut events = Vec::new();
        let mut stream_done = false;
        while !stream_done {
            match stream.receiver.try_recv() {
                Ok(event) => {
                    if let GrpcServerStreamEvent::StreamClosed(_) = &event {
                        stream_done = true;
                    }
                    events.push(event);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stream_done = true;
                    break;
                }
            }
        }

        // Block on the channel only if there were no buffered events
        if !stream_done && events.is_empty() {
            match stream.receiver.recv().await {
                Some(event) => {
                    if let GrpcServerStreamEvent::StreamClosed(_) = &event {
                        stream_done = true;
                    }
                    events.push(event);
                }
                None => stream_done = true,
            }
        }

        // Delete stream if done
        if stream_done {
            let mut client = GrpcClient::get().lock().await;
            let channel = client.channels[channel_id].as_mut().unwrap();
            free_slot(&mut channel.server_streams, stream_id);
        }

        // Return events
        return Ok(GrpcServerStreamResponse {
            _events: events,
            _done: stream_done,
        });
    }
}
