use dashql_native_proxy::route_proxy_request;
use http::Request;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// A proxy request passed in from JavaScript
#[napi(object)]
pub struct ProxyRequest {
    /// The HTTP method
    pub method: String,
    /// The request URL
    pub url: String,
    /// The request headers as `[name, value]` pairs
    pub headers: Vec<Vec<String>>,
    /// The request body
    pub body: Buffer,
}

/// A proxy response returned to JavaScript
#[napi(object)]
pub struct ProxyResponse {
    /// The HTTP status code
    pub status: u32,
    /// The canonical reason phrase of the status code, empty if unknown
    pub status_text: String,
    /// The response headers as `[name, value]` pairs, skipping non-ASCII values
    pub headers: Vec<Vec<String>>,
    /// The response body
    pub body: Buffer,
}

#[napi]
pub fn health() -> &'static str {
    "dashql-native-napi:ok"
}

#[napi]
pub async fn route(request: ProxyRequest) -> napi::Result<ProxyResponse> {
    let mut builder = Request::builder().method(request.method.as_str()).uri(request.url.as_str());
    for header in request.headers {
        if header.len() != 2 {
            return Err(napi::Error::from_reason("proxy headers must contain a name and value"));
        }
        builder = builder.header(header[0].as_str(), header[1].as_str());
    }
    let request = builder
        .body(request.body.to_vec())
        .map_err(|error| napi::Error::from_reason(format!("invalid proxy request: {error}")))?;
    let response = route_proxy_request(request).await;
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|value| vec![name.to_string(), value.to_string()]))
        .collect();
    Ok(ProxyResponse {
        status: response.status().as_u16().into(),
        status_text: response.status().canonical_reason().unwrap_or_default().to_string(),
        headers,
        body: response.body().clone().into(),
    })
}
