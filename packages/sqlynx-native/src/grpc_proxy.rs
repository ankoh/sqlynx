use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::sync::RwLock;
use std::result::Result;

use tauri::http::uri::PathAndQuery;
use tauri::http::HeaderMap;
use tauri::http::HeaderValue;
use tonic::transport::channel::Endpoint;

use crate::grpc_client::GenericGrpcClient;
use crate::grpc_stream_manager::GrpcStreamManager;
use crate::status::Status;

pub const HEADER_PREFIX: &'static str = "sqlynx-";
pub const HEADER_NAME_HOST: &'static str = "sqlynx-host";
pub const HEADER_NAME_TLS_CLIENT_KEY: &'static str = "sqlynx-tls-client-key";
pub const HEADER_NAME_TLS_CLIENT_CERT: &'static str = "sqlynx-tls-client-cert";
pub const HEADER_NAME_TLS_CACERTS: &'static str = "sqlynx-tls-cacerts";
pub const HEADER_NAME_PATH: &'static str = "sqlynx-path";
pub const HEADER_NAME_CHANNEL_ID: &'static str = "sqlynx-channel-id";
pub const HEADER_NAME_STREAM_ID: &'static str = "sqlynx-stream-id";

struct GrpcRequestTlsConfig {
    client_key: String,
    client_cert: String,
    cacerts: String,
}

struct GrpcChannelParams {
    endpoint: Endpoint,
    tls: Option<GrpcRequestTlsConfig>,
}

pub struct GrpcChannelEntry {
    pub channel: tonic::transport::Channel,
}

#[derive(Default)]
pub struct GrpcProxy {
    pub next_channel_id: AtomicUsize,
    pub channels: RwLock<HashMap<usize, Arc<GrpcChannelEntry>>>,
    pub streams: Arc<GrpcStreamManager>,
}

/// Helper to unpack parameters for a gRPC channel
fn read_channel_params(headers: &mut HeaderMap) -> Result<GrpcChannelParams, Status> {
    let mut host = None;
    let mut tls_client_key = None;
    let mut tls_client_cert = None;
    let mut tls_cacerts = None;
    let mut extra_metadata = HeaderMap::with_capacity(headers.len());

    // Helper to unpack a header value
    let read_header_value = |value: HeaderValue, header: &'static str| -> Result<String, Status> {
        Ok(value
            .to_str()
            .map_err(|e| Status::HeaderHasInvalidEncoding{ header, message: e.to_string() })?
            .to_string())
    };

    // Read all headers in the request, pick up the one from us and declare the remaining as extra
    for (key, value) in headers.drain() {
        let key = match key {
            Some(k) => k,
            None => continue,
        };
        match key.as_str() {
            HEADER_NAME_HOST => {
                host = Some(read_header_value(value, HEADER_NAME_HOST)?);
            }
            HEADER_NAME_TLS_CLIENT_KEY => {
                tls_client_key = Some(read_header_value(value, HEADER_NAME_TLS_CLIENT_KEY)?);
            }
            HEADER_NAME_TLS_CLIENT_CERT => {
                tls_client_cert = Some(read_header_value(value, HEADER_NAME_TLS_CLIENT_CERT)?);
            }
            HEADER_NAME_TLS_CACERTS => {
                tls_cacerts = Some(read_header_value(value, HEADER_NAME_TLS_CACERTS)?);
            }
            _ => {
                if !key.as_str().starts_with(HEADER_PREFIX) {
                    extra_metadata.insert(key, value);
                }
            }
        }
    }

    // Make sure the user provided an endpoint
    let endpoint = if let Some(host) = &host {
        Endpoint::from_str(host).map_err(|e| Status::HeaderIsNotAValidEndpoint { header: HEADER_NAME_HOST, message: e.to_string() })
        ?
    } else {
        return Err(Status::HeaderRequiredButMissing { header: HEADER_NAME_HOST });
    };
    // If the user provided a client key, we also require a client cert and cacerts.
    // XXX Maybe we can relax this a bit.
    let tls = if let Some(client_key) = &tls_client_key {
        if tls_client_cert.is_none() {
            return Err(Status::HeaderRequiredButMissing { header: HEADER_NAME_TLS_CLIENT_CERT });
        }
        if tls_cacerts.is_none() {
            return Err(Status::HeaderRequiredButMissing { header: HEADER_NAME_TLS_CACERTS });
        }
        Some(GrpcRequestTlsConfig {
            client_key: client_key.clone(),
            client_cert: tls_client_cert.unwrap(),
            cacerts: tls_cacerts.unwrap(),
        })
    } else {
        None
    };

    Ok(GrpcChannelParams { endpoint, tls })

}
/// Helper to read a string from request headers
fn require_string_header(headers: &HeaderMap, header_name: &'static str) -> Result<String, Status> {
    if let Some(header) = headers.get(header_name) {
        let header = header
            .to_str()
            .map_err(|e| Status::HeaderHasInvalidEncoding{ header: header_name, message: e.to_string() })?
            .to_string();
        Ok(header)
    } else {
        Err(Status::HeaderRequiredButMissing { header: header_name })
    }
}

/// Helper to read a number from request headers
fn require_number_header(headers: &HeaderMap, header_name: &'static str) -> Result<usize, Status> {
    if let Some(header) = headers.get(header_name) {
        let id_string = header
            .to_str()
            .map_err(|e| Status::HeaderHasInvalidEncoding{ header: header_name, message: e.to_string() })?
            .to_string();
        let id: usize = id_string.parse::<usize>().map_err(|e|
            Status::HeaderIsNotANumber { header: header_name, message: e.to_string() }
        )?;
        Ok(id)
    } else {
        Err(Status::HeaderRequiredButMissing { header: header_name })
    }
}

/// Helper to register a channel
fn register_channel<T>(dict: &RwLock<HashMap<usize, Arc<T>>>, id: usize, req: Arc<T>) {
    if let Ok(mut channels) = dict.write() {
        channels.insert(id, req.clone());
    }
}
/// Helper to remove a channel
fn remove_channel<T>(dict: &RwLock<HashMap<usize, Arc<T>>>, id: usize) {
    if let Ok(mut channels) = dict.write() {
        channels.remove(&id);
    }
}
/// Helper to find a channel
fn find_channel<T>(dict: &RwLock<HashMap<usize, Arc<T>>>, id: usize) -> Option<Arc<T>> {
    if let Ok(channels) = dict.read() {
        channels.get(&id).cloned()
    } else {
        None
    }
}

impl GrpcProxy {
    /// Create a channel
    pub async fn create_channel(&self, headers: &mut HeaderMap) -> Result<usize, Status> {
        let channel_id = self
            .next_channel_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let params = read_channel_params(headers)?;
        let channel = params
            .endpoint
            .connect()
            .await
            .map_err(|e| Status::EndpointConnectFailed{ message: e.to_string() })?;

        register_channel(
            &self.channels,
            channel_id,
            Arc::new(GrpcChannelEntry { channel }),
        );
        Ok(channel_id)
    }
    /// Destroy a channel
    pub async fn destroy_channel(&self, channel_id: usize) -> Result<(), Status> {
        remove_channel(&self.channels, channel_id);
        Ok(())
    }

    /// Call a unary gRPC function
    pub async fn call_unary(&self, channel_id: usize, headers: &HeaderMap, body: Vec<u8>) -> Result<Vec<u8>, Status> {
        let path = require_string_header(headers, HEADER_NAME_PATH)?;
        let channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(Status::ChannelIdIsUnknown { channel_id });
        };
        let mut client = GenericGrpcClient::new(channel_entry.channel.clone());
        let path = PathAndQuery::from_str(&path)
            .map_err(|e| {
                Status::HeaderPathIsInvalid { header: HEADER_NAME_PATH, path: path.to_string(), message: e.to_string() }
            })?;

        let req = tonic::Request::new(body);

        let _response = client.call_unary(req , path).await
            .map_err(|status| Status::GrpcCallFailed { status })?;
        Ok(Vec::new())
    }

    /// Call a gRPC function with results streamed from the server
    pub async fn start_server_stream(&self, channel_id: usize, _headers: &HeaderMap, _body: Vec<u8>) -> Result<(usize, Vec<u8>), Status> {
        let _channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(Status::ChannelIdIsUnknown { channel_id });
        };
        Ok((42, Vec::new()))
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, _channel_id: usize, _stream_id: usize, _headers: &HeaderMap) -> Result<Vec<u8>, Status> {
        Ok(Vec::new())
    }

    /// Destroy a result steram
    pub async fn destroy_server_stream(&self, _channel_id: usize, stream_id: usize) -> Result<(), Status> {
        self.streams.destroy_server_stream(stream_id).await;
        Ok(())
    }
}
