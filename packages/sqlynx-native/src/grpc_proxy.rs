use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::sync::RwLock;
use std::result::Result;
use std::time::Duration;

use tonic::codegen::http::uri::PathAndQuery;
use tauri::http::HeaderMap;
use tauri::http::HeaderValue;
use tonic::metadata::MetadataMap;
use tonic::transport::channel::Endpoint;
use http::HeaderName;

use crate::grpc_client::GenericGrpcClient;
use crate::grpc_stream_manager::GrpcServerStreamBatch;
use crate::grpc_stream_manager::GrpcStreamManager;
use crate::proxy_headers::HEADER_NAME_BATCH_BYTES;
use crate::proxy_headers::HEADER_NAME_BATCH_TIMEOUT;
use crate::proxy_headers::HEADER_NAME_ENDPOINT;
use crate::proxy_headers::HEADER_NAME_PATH;
use crate::proxy_headers::HEADER_NAME_READ_TIMEOUT;
use crate::proxy_headers::HEADER_NAME_TLS_CACERTS;
use crate::proxy_headers::HEADER_NAME_TLS_CLIENT_CERT;
use crate::proxy_headers::HEADER_NAME_TLS_CLIENT_KEY;
use crate::proxy_headers::HEADER_PREFIX;
use crate::status::Status;

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

pub struct GrpcProxy {
    pub next_channel_id: AtomicUsize,
    pub channels: RwLock<HashMap<usize, Arc<GrpcChannelEntry>>>,
    pub streams: Arc<GrpcStreamManager>,
}

impl Default for GrpcProxy {
    fn default() -> Self {
        Self {
            next_channel_id: AtomicUsize::new(1),
            channels: Default::default(),
            streams: Default::default(),
        }
    }
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
        let key = match &key {
            Some(k) => k.as_str(),
            None => continue,
        };
        match key {
            HEADER_NAME_ENDPOINT => {
                host = Some(read_header_value(value, HEADER_NAME_ENDPOINT)?);
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
                if !key.starts_with(HEADER_PREFIX) {
                    if let Ok(header) = HeaderName::try_from(key.to_string()) {
                        extra_metadata.insert(header, value);
                    } else {
                        log::warn!("failed to add extra metadata with key: {}", key);
                    }
                }
            }
        }
    }

    // Make sure the user provided an endpoint
    let endpoint = if let Some(host) = &host {
        Endpoint::from_str(host).map_err(|e| Status::HeaderIsNotAValidEndpoint { header: HEADER_NAME_ENDPOINT, message: e.to_string() })
        ?
    } else {
        return Err(Status::HeaderRequiredButMissing { header: HEADER_NAME_ENDPOINT });
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

/// Helper to read a string from request headers
fn require_usize_header(headers: &HeaderMap, header_name: &'static str) -> Result<usize, Status> {
    if let Some(header) = headers.get(header_name) {
        let header = header
            .to_str()
            .map_err(|e| Status::HeaderHasInvalidEncoding{ header: header_name, message: e.to_string() })?
            .to_string();
        let header: usize = header.parse::<usize>().map_err(|e| Status::HeaderIsNotAnUsize { header: header_name, message: e.to_string() })?;
        Ok(header)
    } else {
        Err(Status::HeaderRequiredButMissing { header: header_name })
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
            .map_err(|e| {
                log::error!("creating a channel failed with error: {:?}", e);
                Status::GrpcEndpointConnectFailed{ message: e.to_string() }
            })?;

        if let Ok(mut channels) = self.channels.write() {
            channels.insert(channel_id, Arc::new(GrpcChannelEntry { channel }));
        }
        Ok(channel_id)
    }
    /// Destroy a channel
    pub async fn destroy_channel(&self, channel_id: usize) -> Result<(), Status> {
        if let Ok(mut channels) = self.channels.write() {
            channels.remove(&channel_id);
        }
        Ok(())
    }

    /// Call a unary gRPC function
    pub async fn call_unary(&self, channel_id: usize, headers: &HeaderMap, body: Vec<u8>) -> Result<(Vec<u8>, MetadataMap), Status> {
        let path = require_string_header(headers, HEADER_NAME_PATH)?;
        let channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(Status::GrpcChannelIdIsUnknown { channel_id });
        };
        let mut client = GenericGrpcClient::new(channel_entry.channel.clone());
        let path = PathAndQuery::from_str(&path)
            .map_err(|e| {
                Status::HeaderPathIsInvalid { header: HEADER_NAME_PATH, path: path.to_string(), message: e.to_string() }
            })?;

        let request = tonic::Request::new(body);
        let mut response = client.call_unary(request, path).await
            .map_err(|status| Status::GrpcCallFailed { status })?;
        let metadata = std::mem::take(response.metadata_mut());
        let body = response.into_inner();
        Ok((body, metadata))
    }

    /// Call a gRPC function with results streamed from the server
    pub async fn start_server_stream(&self, channel_id: usize, headers: &HeaderMap, body: Vec<u8>) -> Result<(usize, MetadataMap), Status> {
        let path = require_string_header(headers, HEADER_NAME_PATH)?;
        let channel_entry = if let Some(channel) = self.channels.read().unwrap().get(&channel_id) {
            channel.clone()
        } else {
            return Err(Status::GrpcChannelIdIsUnknown { channel_id });
        };

        // Send the gRPC request
        let mut client = GenericGrpcClient::new(channel_entry.channel.clone());
        let path = PathAndQuery::from_str(&path)
            .map_err(|e| {
                Status::HeaderPathIsInvalid { header: HEADER_NAME_PATH, path: path.to_string(), message: e.to_string() }
            })?;
        let request = tonic::Request::new(body);
        let mut response = client.call_server_streaming(request, path).await
            .map_err(|status| Status::GrpcCallFailed { status })?;

        // Save the response headers
        let response_headers = std::mem::take(response.metadata_mut());

        // Register the output stream
        let streaming = response.into_inner();
        let stream_id = self.streams.start_server_stream(channel_id, streaming)?;

        Ok((stream_id, response_headers))
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, channel_id: usize, stream_id: usize, headers: &HeaderMap) -> Result<GrpcServerStreamBatch, Status> {
        // We don't need the channel id to resolve the stream today since the stream id is unique across all channels.
        // We still check if the channel id exists so that we can still maintain streams per channel later.
        if self.channels.read().unwrap().get(&channel_id).is_none() {
            return Err(Status::GrpcChannelIdIsUnknown { channel_id });
        }
        // Read limits from request headers
        let read_timeout = require_usize_header(headers, HEADER_NAME_READ_TIMEOUT)?;
        let batch_timeout = require_usize_header(headers, HEADER_NAME_BATCH_TIMEOUT)?;
        let batch_bytes = require_usize_header(headers, HEADER_NAME_BATCH_BYTES)?;

        // Read from the stream
        let read_timeout_duration = Duration::from_millis(read_timeout as u64);
        let batch_timeout_duration = Duration::from_millis(batch_timeout as u64);
        let read_result = self.streams.read_server_stream(channel_id, stream_id, read_timeout_duration, batch_timeout_duration, batch_bytes).await?;
        Ok(read_result)
    }

    /// Destroy a result steram
    pub async fn destroy_server_stream(&self, _channel_id: usize, stream_id: usize) -> Result<(), Status> {
        self.streams.destroy_server_stream(stream_id).await;
        Ok(())
    }
}
