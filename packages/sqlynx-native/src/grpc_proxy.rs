use std::str::FromStr;
use std::sync::Arc;

use anyhow::anyhow;
use anyhow::Result;
use tauri::http::uri::PathAndQuery;
use tauri::http::HeaderMap;
use tauri::http::HeaderValue;
use tauri::http::Request;
use tauri::http::Response;
use tonic::transport::channel::Endpoint;

use crate::grpc_stream_registry::GrpcStreamRegistry;

#[derive(Default)]
pub struct GrpcHttpProxy {
    streams: Arc<GrpcStreamRegistry>,
}

struct GrpcRequestTlsConfig {
    client_key: String,
    client_cert: String,
    cacerts: String,
}

struct GrpcRequestParams {
    endpoint: Endpoint,
    path: PathAndQuery,
    tls: Option<GrpcRequestTlsConfig>,
}

impl GrpcHttpProxy {
    /// Helper to unpack parameters for a gRPC call
    fn read_request_params(req: &mut Request<Vec<u8>>) -> Result<GrpcRequestParams> {
        // Helper to read a header value as string
        let read_header_value = |value: HeaderValue, header: &'static str| -> Result<String> {
            Ok(value
                .to_str()
                .map_err(|e| {
                    anyhow!(
                        "request header '{}' is not a valid ASCII string: {}",
                        header,
                        e
                    )
                })?
                .to_string())
        };

        let mut host = None;
        let mut path = None;
        let mut tls_client_key = None;
        let mut tls_client_cert = None;
        let mut tls_cacerts = None;
        let mut extra_metadata = HeaderMap::with_capacity(req.headers().len());

        // Read all headers in the request, pick up the one from us and declare the remaining as extra
        for (key, value) in req.headers_mut().drain() {
            let key = match key {
                Some(k) => k,
                None => continue,
            };
            match key.as_str() {
                "sqlynx-host" => {
                    host = Some(read_header_value(value, "sqlynx-host")?);
                }
                "sqlynx-path" => {
                    path = Some(read_header_value(value, "sqlynx-path")?);
                }
                "sqlynx-tls-client-key" => {
                    tls_client_key = Some(read_header_value(value, "sqlynx-tls-client-key")?);
                }
                "sqlynx-tls-client-cert" => {
                    tls_client_cert = Some(read_header_value(value, "sqlynx-tls-client-cert")?);
                }
                "sqlynx-tls-cacerts" => {
                    tls_cacerts = Some(read_header_value(value, "sqlynx-tls-cacerts")?);
                }
                _ => {
                    if !key.as_str().starts_with("sqlynx-") {
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
        // Make sure the user provided a path
        let path = if let Some(path) = &path {
            PathAndQuery::from_str(path)
                .map_err(|e| anyhow!("request header 'sqlynx-path' is not a valid path: {}", e))?
        } else {
            return Err(anyhow!("request misses required header 'sqlynx-path'"));
        };
        // If the user provided a client key, we also require a client cert and cacerts.
        // XXX Maybe we can relax this a bit.
        let tls = if let Some(client_key) = &tls_client_key {
            if tls_client_cert.is_none() {
                return Err(anyhow!(
                    "request misses required tls header 'sqlynx-tls-client-cert'"
                ));
            }
            if tls_cacerts.is_none() {
                return Err(anyhow!(
                    "request misses required tls header 'sqlynx-tls-cacerts'"
                ));
            }
            Some(GrpcRequestTlsConfig {
                client_key: client_key.clone(),
                client_cert: tls_client_cert.unwrap(),
                cacerts: tls_cacerts.unwrap(),
            })
        } else {
            None
        };

        Ok(GrpcRequestParams {
            endpoint,
            path,
            tls,
        })
    }

    /// Call a unary gRPC function
    pub async fn call_unary(&self, mut req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        let params = GrpcHttpProxy::read_request_params(&mut req)?;
        let channel = params
            .endpoint
            .connect()
            .await
            .map_err(|e| anyhow!("connect to endpoint failed with error: {}", e))?;

        // tonic::client::Grpc

        Ok(Vec::new())
    }

    /// Call a gRPC function with results streamed from the server
    pub async fn start_server_stream(&self, mut req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        let _params = GrpcHttpProxy::read_request_params(&mut req);

        Ok(Vec::new())
    }

    /// Read from a result stream
    pub async fn read_server_stream(&self, _req: Request<Vec<u8>>) -> Result<Vec<u8>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod test {
    use super::*;
}
