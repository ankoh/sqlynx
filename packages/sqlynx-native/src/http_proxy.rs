use std::{str::FromStr, sync::Arc};

use crate::http_stream_manager::HttpServerStreamBatch;
use http::{HeaderMap, HeaderName, HeaderValue};
use std::time::Duration;
use url::Url;

use crate::{http_stream_manager::HttpStreamManager, proxy_headers::{HEADER_NAME_BATCH_BYTES, HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_ENDPOINT, HEADER_NAME_METHOD, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_PREFIX}, status::Status};

struct HttpRequestParams {
    method: http::Method,
    endpoint: Url,
    path_and_query: String,
    read_timeout: usize,
    headers: HeaderMap<HeaderValue>
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

/// Helper to unpack request parameters
fn read_request_params(headers: &mut HeaderMap) -> Result<HttpRequestParams, Status> {
    // Copy all headers in the request that don't start with sqlynx-
    let mut extra_metadata = HeaderMap::with_capacity(headers.len());
    for (key, value) in headers.drain() {
        let key = match &key {
            Some(k) => k.as_str(),
            None => continue,
        };
        if !key.starts_with(HEADER_PREFIX) {
            if let Ok(header) = HeaderName::try_from(key.to_string()) {
                extra_metadata.insert(header, value);
            } else {
                log::warn!("failed to add extra metadata with key: {}", key);
            }
        }
    }
    let method = require_string_header(headers, HEADER_NAME_METHOD)?;
    let endpoint = require_string_header(headers, HEADER_NAME_ENDPOINT)?;
    let path_and_query = require_string_header(headers, HEADER_NAME_PATH)?;
    let read_timeout = require_usize_header(headers, HEADER_NAME_READ_TIMEOUT)?;

    let endpoint = url::Url::parse(&endpoint)
        .map_err(|e| {
            Status::HttpEndpointIsInvalid { header: HEADER_NAME_ENDPOINT, endpoint: endpoint.to_string(), message: e.to_string() }
        })?;
    let method = http::Method::from_str(&method)
        .map_err(|e| {
            Status::HttpMethodIsInvalid { header: HEADER_NAME_METHOD, method: method.to_string(), message: e.to_string() }
        })?;

    Ok(HttpRequestParams { method, endpoint, path_and_query, read_timeout, headers: extra_metadata })
}

#[derive(Default)]
pub struct HttpProxy {
    pub streams: Arc<HttpStreamManager>,
}

impl HttpProxy {
    /// Call a unary gRPC function
    pub async fn start_server_stream(&self, headers: &mut HeaderMap, body: Vec<u8>) -> Result<usize, Status> {
        let mut params = read_request_params(headers)?;
        let url = params.endpoint.join(&params.path_and_query)
            .map_err(|e| {
                Status::HeaderPathIsInvalid { header: HEADER_NAME_PATH, path: params.path_and_query, message: e.to_string() }
            })?;
        let client = reqwest::Client::builder()
            .read_timeout(Duration::from_millis(params.read_timeout as u64))
            .build()
            .map_err(|e| {
                Status::HttpClientConfigInvalid { message: e.to_string() }
            })?;
        let mut request = reqwest::Request::new(
            params.method,
            url
        );
        *request.body_mut() = Some(body.into());
        std::mem::swap(&mut params.headers, &mut request.headers_mut());
        self.streams.start_server_stream(client, request)
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, stream_id: usize, headers: &HeaderMap) -> Result<HttpServerStreamBatch, Status> {
        // Read limits from request headers
        let read_timeout = require_usize_header(headers, HEADER_NAME_READ_TIMEOUT)?;
        let batch_timeout = require_usize_header(headers, HEADER_NAME_BATCH_TIMEOUT)?;
        let batch_bytes = require_usize_header(headers, HEADER_NAME_BATCH_BYTES)?;

        // Read from the stream
        let read_timeout_duration = Duration::from_millis(read_timeout as u64);
        let batch_timeout_duration = Duration::from_millis(batch_timeout as u64);
        let read_result = self.streams.read_server_stream(stream_id, read_timeout_duration, batch_timeout_duration, batch_bytes).await?;
        Ok(read_result)
    }

    /// Destroy a server stream
    pub async fn destroy_server_stream(&self, stream_id: usize) -> Result<(), Status> {
        self.streams.destroy_server_stream(stream_id).await;
        Ok(())
    }
}
