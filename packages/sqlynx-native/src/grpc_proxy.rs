use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::RwLock;

use anyhow::anyhow;
use anyhow::Result;
use tauri::http::uri::PathAndQuery;
use tauri::http::HeaderMap;
use tauri::http::HeaderValue;
use tauri::http::Request;
use tonic::transport::channel::Endpoint;

use crate::grpc_client::GenericGrpcClient;
use crate::grpc_stream_manager::GrpcStreamManager;

const HEADER_PREFIX: &'static str = "sqlynx-";
const HEADER_NAME_HOST: &'static str = "sqlynx-host";
const HEADER_NAME_TLS_CLIENT_KEY: &'static str = "sqlynx-tls-client-key";
const HEADER_NAME_TLS_CLIENT_CERT: &'static str = "sqlynx-tls-client-cert";
const HEADER_NAME_TLS_CACERTS: &'static str = "sqlynx-tls-cacerts";
const HEADER_NAME_CHANNEL_ID: &'static str = "sqlynx-channel-id";
const HEADER_NAME_STREAM_ID: &'static str = "sqlynx-stream-id";

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
    pub next_channel_id: AtomicU64,
    pub channels: RwLock<HashMap<u64, Arc<GrpcChannelEntry>>>,
    pub streams: Arc<GrpcStreamManager>,
}

/// Helper to unpack parameters for a gRPC channel
fn read_channel_params(req: &mut Request<Vec<u8>>) -> Result<GrpcChannelParams> {
    let mut host = None;
    let mut tls_client_key = None;
    let mut tls_client_cert = None;
    let mut tls_cacerts = None;
    let mut extra_metadata = HeaderMap::with_capacity(req.headers().len());

    // Helper to unpack a header value
    let read_header_value = |value: HeaderValue, header: &'static str| -> Result<String> {
        Ok(value
            .to_str()
            .map_err(|e| anyhow!("request header '{}' has an invalid encoding: {}", header, e))?
            .to_string())
    };

    // Read all headers in the request, pick up the one from us and declare the remaining as extra
    for (key, value) in req.headers_mut().drain() {
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
        Endpoint::from_str(host).map_err(|e| {
            anyhow!(
                "request header 'sqlynx-host' is not a valid endpoint: {}",
                e
            )
        })?
    } else {
        return Err(anyhow!("request misses required header 'sqlynx-host'"));
    };
    // If the user provided a client key, we also require a client cert and cacerts.
    // XXX Maybe we can relax this a bit.
    let tls = if let Some(client_key) = &tls_client_key {
        if tls_client_cert.is_none() {
            return Err(anyhow!("request misses required tls header '{}'", HEADER_NAME_TLS_CLIENT_CERT));
        }
        if tls_cacerts.is_none() {
            return Err(anyhow!("request misses required tls header '{}'", HEADER_NAME_TLS_CACERTS));
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

/// Helper to read a stream id from request headers
fn require_id_header<V>(req: &Request<V>, header_name: &'static str) -> Result<u64> {
    if let Some(header) = req.headers().get(header_name) {
        let id_string = header
            .to_str()
            .map_err(|e| {
                anyhow!("request header '{}' has an invalid encoding: {}", header_name, e)
            })?
            .to_string();
        let id: u64 = id_string.parse().map_err(|e| {
            anyhow!("request header '{}' is not a number: {}", header_name, e)
        })?;
        Ok(id)
    } else {
        Err(anyhow!("missing required header '{}'", header_name))
    }
}

/// Helper to register a channel
fn register_channel<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64, req: Arc<T>) {
    if let Ok(mut channels) = dict.write() {
        channels.insert(id, req.clone());
    }
}
/// Helper to remove a channel
fn remove_channel<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64) {
    if let Ok(mut channels) = dict.write() {
        channels.remove(&id);
    }
}
/// Helper to find a channel
fn find_channel<T>(dict: &RwLock<HashMap<u64, Arc<T>>>, id: u64) -> Option<Arc<T>> {
    if let Ok(channels) = dict.read() {
        channels.get(&id).cloned()
    } else {
        None
    }
}

impl GrpcProxy {
    /// Create a channel
    pub async fn create_channel(&self, mut req: Request<Vec<u8>>) -> Result<u64> {
        let channel_id = self
            .next_channel_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let params = read_channel_params(&mut req)?;
        let channel = params
            .endpoint
            .connect()
            .await
            .map_err(|e| anyhow!("connect to endpoint failed with error: {}", e))?;

        register_channel(
            &self.channels,
            channel_id,
            Arc::new(GrpcChannelEntry { channel }),
        );
        Ok(channel_id)
    }
    /// Destroy a channel
    pub async fn destroy_channel(&self, req: Request<Vec<u8>>) -> Result<()> {
        let channel_id = require_id_header(&req, HEADER_NAME_CHANNEL_ID)?;
        remove_channel(&self.channels, channel_id);
        Ok(())
    }

    /// Call a unary gRPC function
    pub async fn call_unary(&self, req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        let channel_id = require_id_header(&req, HEADER_NAME_CHANNEL_ID)?;
        let channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(anyhow!("channel id refers to unknown channel '{}'", channel_id));
        };
        let _client = GenericGrpcClient::new(channel_entry.channel.clone());
        // let path = PathAndQuery::from_static();
        // let response = client.call_unary(req, path).await?;
        Ok(Vec::new())
    }

    /// Call a gRPC function with results streamed from the server
    pub async fn start_server_stream(&self, req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        let channel_id = require_id_header(&req, HEADER_NAME_CHANNEL_ID)?;
        let _channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(anyhow!("channel id refers to unknown channel '{}'", channel_id));
        };
        Ok(Vec::new())
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        let _stream_id = require_id_header(&req, HEADER_NAME_STREAM_ID)?;
        Ok(Vec::new())
    }
}
