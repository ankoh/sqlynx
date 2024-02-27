use std::str::FromStr;
use std::sync::Arc;

use anyhow::anyhow;
use anyhow::Result;
use tauri::http::uri::PathAndQuery;
use tauri::http::HeaderMap;
use tauri::http::HeaderValue;
use tauri::http::Request;
use tonic::transport::channel::Endpoint;

use crate::grpc_stream_registry::GrpcStreamRegistry;

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
    fn read_params(req: &mut Request<Vec<u8>>) -> Result<GrpcRequestParams> {
        let headers = req.headers_mut();
        let read_header_value = |value: &mut HeaderValue, header: &'static str| -> Result<String> {
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
        let mut extra_metadata = HeaderMap::with_capacity(headers.len());

        for (key, mut value) in headers.drain() {
            let key = match key {
                Some(k) => k,
                None => continue,
            };
            match key.as_str() {
                "sqlynx-host" => {
                    host = Some(read_header_value(&mut value, "sqlynx-host")?);
                }
                "sqlynx-path" => {
                    path = Some(read_header_value(&mut value, "sqlynx-path")?);
                }
                "sqlynx-tls-client-key" => {
                    tls_client_key = Some(read_header_value(&mut value, "sqlynx-tls-client-key")?);
                }
                "sqlynx-tls-client-cert" => {
                    tls_client_cert =
                        Some(read_header_value(&mut value, "sqlynx-tls-client-cert")?);
                }
                "sqlynx-tls-cacerts" => {
                    tls_cacerts = Some(read_header_value(&mut value, "sqlynx-tls-cacerts")?);
                }
                _ => {
                    extra_metadata.insert(key, value);
                }
            }
        }

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
        let path = if let Some(path) = &path {
            PathAndQuery::from_str(path)
                .map_err(|e| anyhow!("request header 'sqlynx-path' is not a valid path: {}", e))?
        } else {
            return Err(anyhow!("request misses required header 'sqlynx-path'"));
        };
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

    //    pub async fn call_unary(req: Request<Vec<u8>>) -> Response<Vec<u8>> {}
    //
    //    pub async fn start_server_stream(req: Request<Vec<u8>>) -> Response<Vec<u8>> {}
    //
    //    pub async fn read_server_stream(req: Request<Vec<u8>>) -> Response<Vec<u8>> {}
}
