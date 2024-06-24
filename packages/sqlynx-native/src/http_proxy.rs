use std::{str::FromStr, sync::Arc};

use crate::http_stream_manager::HttpServerStreamBatch;
use http::{HeaderMap, HeaderName, HeaderValue};
use std::time::Duration;
use url::Url;

use crate::{http_stream_manager::HttpStreamManager, proxy_headers::{HEADER_NAME_BATCH_BYTES, HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_ENDPOINT, HEADER_NAME_METHOD, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_PREFIX}, status::Status};

#[derive(Debug)]
struct HttpRequestParams {
    method: http::Method,
    url: Url,
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
    let mut extra_metadata = HeaderMap::with_capacity(headers.len());
    let method = require_string_header(headers, HEADER_NAME_METHOD)?;
    let endpoint = require_string_header(headers, HEADER_NAME_ENDPOINT)?;
    let path_and_query = require_string_header(headers, HEADER_NAME_PATH)?;
    let read_timeout = require_usize_header(headers, HEADER_NAME_READ_TIMEOUT)?;

    // Copy all headers in the request that don't start with sqlynx-
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
    // Remove some headers set by the webviews fetch call
    extra_metadata.remove("origin");

    let url_text = format!("{}{}", &endpoint, &path_and_query);
    let url = url::Url::parse(&url_text)
        .map_err(|e| {
            Status::HttpEndpointIsInvalid { header: HEADER_NAME_ENDPOINT, endpoint: url_text, message: e.to_string() }
        })?;
    let method = http::Method::from_str(&method)
        .map_err(|e| {
            Status::HttpMethodIsInvalid { header: HEADER_NAME_METHOD, method: method.to_string(), message: e.to_string() }
        })?;

    Ok(HttpRequestParams { method, url, read_timeout, headers: extra_metadata })
}

#[derive(Default)]
pub struct HttpProxy {
    pub streams: Arc<HttpStreamManager>,
}

impl HttpProxy {
    /// Start a server stream function
    pub async fn start_server_stream(&self, headers: &mut HeaderMap, body: Vec<u8>) -> Result<usize, Status> {
        let mut params = read_request_params(headers)?;
        log::debug!("remote: {:?}", params.url.to_string());
        let client = reqwest::Client::builder()
            .read_timeout(Duration::from_millis(params.read_timeout as u64))
            .build()
            .map_err(|e| {
                Status::HttpClientConfigInvalid { message: e.to_string() }
            })?;
        let mut request = reqwest::Request::new(
            params.method,
            params.url
        );
        *request.body_mut() = Some(body.into());
        std::mem::swap(&mut params.headers, &mut request.headers_mut());
        self.streams.start_server_stream(client, request)
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, stream_id: usize, headers: &HeaderMap) -> Result<HttpServerStreamBatch, Status> {
        log::debug!("read from http stream {}", stream_id);

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
