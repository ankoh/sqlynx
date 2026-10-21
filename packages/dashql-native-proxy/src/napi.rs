use dashql_native_proxy::route_proxy_request;
use http::Request;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct ProxyRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Vec<String>>,
    pub body: Buffer,
}

#[napi(object)]
pub struct ProxyResponse {
    pub status: u32,
    pub status_text: String,
    pub headers: Vec<Vec<String>>,
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
