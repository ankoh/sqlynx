use std::{collections::HashMap, fmt::Error};
use serde::Serialize;
use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};

use crate::proxy_headers::{HEADER_NAME_ERROR, HEADER_NAME_GRPC_STATUS};

#[derive(Debug)]
pub enum GrpcStreamElement {
    Message,
    Trailers,
}

#[derive(Debug)]
pub enum Status {
    GrpcCallFailed{ status: tonic::Status },
    GrpcChannelIdIsUnknown{ channel_id: usize },
    GrpcEndpointConnectFailed{ message: String },
    GrpcStreamClosed { channel_id: usize, stream_id: usize },
    GrpcStreamIsUnknown { channel_id: usize, stream_id: usize },
    GrpcStreamReadFailed { channel_id: usize, stream_id: usize, element: GrpcStreamElement, status: tonic::Status },
    GrpcStreamReadTimedOut { channel_id: usize, stream_id: usize },
    HeaderHasInvalidEncoding{ header: &'static str, message: String },
    HeaderIsNotAValidEndpoint{ header: &'static str, message: String },
    HeaderIsNotAnUsize{ header: &'static str, message: String },
    HeaderPathIsInvalid{ header: &'static str, path: String, message: String },
    HeaderRequiredButMissing{ header: &'static str },
    HttpClientConfigInvalid{ message: String },
    HttpEndpointIsInvalid{ header: &'static str, endpoint: String, message: String },
    HttpMethodIsInvalid{ header: &'static str, method: String, message: String },
    HttpRequestFailed { stream_id: usize, error: String },
    HttpStreamClosed { stream_id: usize },
    HttpStreamFailed { stream_id: usize, error: String },
    HttpStreamIsUnknown { stream_id: usize },
    HttpStreamReadFailed { stream_id: usize, error: String },
    HttpStreamReadTimedOut { stream_id: usize },
    HttpUrlIsInvalid{ message: String },
}

#[derive(Serialize)]
pub struct StatusMessage {
    message: String,
    details: HashMap<&'static str, String>,
}

impl TryFrom<&Status> for StatusMessage {
    type Error = std::fmt::Error;

    fn try_from(s: &Status) -> Result<StatusMessage, Error> {
        match s {
            Status::HeaderHasInvalidEncoding { header, message } => Ok(StatusMessage {
                message: "header has an invalid encoding".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::HeaderIsNotAValidEndpoint { header, message } => Ok(StatusMessage {
                message: "header is not a valid endpoint".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::HeaderRequiredButMissing { header } => Ok(StatusMessage {
                message: "header is missing".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string())
                ]),
            }),
            Status::HeaderIsNotAnUsize { header, message } => Ok(StatusMessage {
                message: "header is not an unsigned integer".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::HeaderPathIsInvalid { header, path, message } => Ok(StatusMessage {
                message: "header stores invalid path".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("path", path.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::HttpEndpointIsInvalid { header, endpoint, message } => Ok(StatusMessage {
                message: "header stores invalid endpoint".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("endpoint", endpoint.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::HttpMethodIsInvalid { header, method, message } => Ok(StatusMessage {
                message: "header stores invalid method".to_string(),
                details: HashMap::from_iter([
                    ("header", header.to_string()),
                    ("method", method.to_string()),
                    ("error", message.to_string())
                ]),
            }),
            Status::GrpcChannelIdIsUnknown { channel_id } => Ok(StatusMessage {
                message: "gRPC channel id is unknown".to_string(),
                details: HashMap::from_iter([
                    ("channel", channel_id.to_string()),
                ]),
            }),
            Status::GrpcEndpointConnectFailed { message } => Ok(StatusMessage {
                message: format!("connecting to gRPC endpoint failed"),
                details: HashMap::from_iter([
                    ("error", message.to_string()),
                ]),
            }),
            Status::GrpcCallFailed { status } => Ok(StatusMessage {
                message: "gRPC call failed".to_string(),
                details: HashMap::from_iter([
                    ("code", status.code().to_string()),
                    ("error", status.to_string()),
                ]),
            }),
            Status::GrpcStreamReadFailed {  channel_id, stream_id, element, status  } => Ok(StatusMessage {
                message: "reading from gRPC stream failed".to_string(),
                details: HashMap::from_iter([
                    ("target", match element { GrpcStreamElement::Trailers => "trailers", GrpcStreamElement::Message => "message" }.to_string()),
                    ("stream", stream_id.to_string()),
                    ("channel", channel_id.to_string()),
                    ("code", status.code().to_string()),
                    ("error", status.to_string()),
                ]),
            }),
            Status::GrpcStreamReadTimedOut { channel_id, stream_id } => Ok(StatusMessage {
                message: "reading from gRPC stream timed out".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("channel", channel_id.to_string()),
                ]),
            }),
            Status::GrpcStreamIsUnknown { channel_id, stream_id } => Ok(StatusMessage {
                message: "gRPC stream is unknown".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("channel", channel_id.to_string()),
                ]),
            }),
            Status::GrpcStreamClosed { channel_id, stream_id } => Ok(StatusMessage {
                message: "gRPC stream is closed".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("channel", channel_id.to_string()),
                ]),
            }),
            Status::HttpRequestFailed { stream_id, error } => Ok(StatusMessage {
                message: "http request failed".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("error", error.to_string()),
                ]),
            }),
            Status::HttpStreamReadFailed { stream_id, error } => Ok(StatusMessage {
                message: "reading chunk from http stream failed".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("error", error.to_string()),
                ]),
            }),
            Status::HttpStreamReadTimedOut { stream_id } => Ok(StatusMessage {
                message: "reading from http stream timed out".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                ]),
            }),
            Status::HttpStreamIsUnknown { stream_id } => Ok(StatusMessage {
                message: "http stream is unknown".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                ]),
            }),
            Status::HttpStreamClosed { stream_id } => Ok(StatusMessage {
                message: "http stream is closed".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                ]),
            }),
            Status::HttpStreamFailed { stream_id, error } => Ok(StatusMessage {
                message: "http stream failed".to_string(),
                details: HashMap::from_iter([
                    ("stream", stream_id.to_string()),
                    ("error", error.to_string()),
                ]),
            }),
            Status::HttpClientConfigInvalid {  message } => Ok(StatusMessage {
                message: format!("http client config is invalid"),
                details: HashMap::from_iter([
                    ("error", message.to_string()),
                ]),
            }),
            Status::HttpUrlIsInvalid { message } => Ok(StatusMessage {
                message: format!("http url is invalid"),
                details: HashMap::from_iter([
                    ("error", message.to_string()),
                ]),
            }),
        }
    }
}

impl From<&Status> for StatusCode {
    fn from(status: &Status) -> StatusCode {
        match status {
            Status::GrpcCallFailed { status: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcChannelIdIsUnknown { channel_id: _ } => StatusCode::NOT_FOUND,
            Status::GrpcEndpointConnectFailed { message: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamClosed { channel_id: _, stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamIsUnknown { channel_id: _, stream_id: _ } => StatusCode::NOT_FOUND,
            Status::GrpcStreamReadFailed { channel_id: _, stream_id: _, element: _, status: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamReadTimedOut { channel_id: _, stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderHasInvalidEncoding { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderIsNotAValidEndpoint { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderIsNotAnUsize { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderPathIsInvalid { header: _, path: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderRequiredButMissing { header: _ } => StatusCode::BAD_REQUEST,
            Status::HttpClientConfigInvalid { message: _ } => StatusCode::BAD_REQUEST,
            Status::HttpEndpointIsInvalid { header: _, endpoint: _ , message: _ } => StatusCode::BAD_REQUEST,
            Status::HttpMethodIsInvalid { header: _, method: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HttpRequestFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamClosed { stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamIsUnknown { stream_id: _ } => StatusCode::NOT_FOUND,
            Status::HttpStreamReadFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamReadTimedOut { stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HttpUrlIsInvalid { message: _ } => StatusCode::BAD_REQUEST,
        }
    }
}

impl From<&Status> for Response<Vec<u8>> {
    fn from(s: &Status) -> Response<Vec<u8>> {
        let mut body: Vec<u8> = Vec::new();
        if let Ok(status_msg) = StatusMessage::try_from(s) {
            body = serde_json::to_vec(&status_msg).unwrap_or_default();
        }
        match &s {
            Status::GrpcCallFailed { ref status } => {
                let grpc_code = (status.code() as usize).to_string();
                Response::builder()
                    .status(StatusCode::from(s).as_u16())
                    .header(HEADER_NAME_ERROR, "true")
                    .header(HEADER_NAME_GRPC_STATUS, &grpc_code)
                    .header(CONTENT_TYPE, mime::APPLICATION_JSON.essence_str())
                    .body(body)
                    .unwrap()
            },
            Status::GrpcStreamReadFailed { channel_id: _, stream_id: _, element: _, ref status } => {
                let grpc_code = (status.code() as usize).to_string();
                Response::builder()
                    .status(StatusCode::from(s).as_u16())
                    .header(HEADER_NAME_ERROR, "true")
                    .header(HEADER_NAME_GRPC_STATUS, &grpc_code)
                    .header(CONTENT_TYPE, mime::APPLICATION_JSON.essence_str())
                    .body(body)
                    .unwrap()
            },
            _ => {
                Response::builder()
                    .status(StatusCode::from(s).as_u16())
                    .header(HEADER_NAME_ERROR, "true")
                    .header(CONTENT_TYPE, mime::APPLICATION_JSON.essence_str())
                    .body(body)
                    .unwrap()
            }
        }
    }
}
