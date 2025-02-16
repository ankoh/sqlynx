use std::fmt::Error;
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
    details: Option<String>,
}

impl TryFrom<&Status> for StatusMessage {
    type Error = std::fmt::Error;

    fn try_from(s: &Status) -> Result<StatusMessage, Error> {
        match s {
            Status::HeaderHasInvalidEncoding { header, message } => Ok(StatusMessage {
                message: format!("header '{}' has an invalid encoding", header),
                details: Some(message.to_string())
            }),
            Status::HeaderIsNotAValidEndpoint { header, message } => Ok(StatusMessage {
                message: format!("header '{}' is not a valid endpoint", header),
                details: Some(message.to_string()),
            }),
            Status::HeaderRequiredButMissing { header } => Ok(StatusMessage {
                message: format!("header '{}' is missing", header),
                details: None,
            }),
            Status::HeaderIsNotAnUsize { header, message } => Ok(StatusMessage {
                message: format!("header '{}' is not an unsigned integer", header),
                details: Some(message.to_string()),
            }),
            Status::HeaderPathIsInvalid { header, path, message } => Ok(StatusMessage {
                message: format!("header '{}' stores the path '{}' and is invalid", header, path),
                details: Some(message.to_string()),
            }),
            Status::HttpEndpointIsInvalid { header, endpoint, message } => Ok(StatusMessage {
                message: format!("header '{}' stores endpoint '{}' which is invalid", header, endpoint),
                details: Some(message.to_string())
            }),
            Status::HttpMethodIsInvalid { header, method, message } => Ok(StatusMessage {
                message: format!("header '{}' stores method '{}' which is invalid", header, method),
                details: Some(message.to_string())
            }),
            Status::GrpcChannelIdIsUnknown { channel_id } => Ok(StatusMessage {
                message: format!("gRPC channel id {} is unknown", channel_id),
                details: None
            }),
            Status::GrpcEndpointConnectFailed { message } => Ok(StatusMessage {
                message: format!("connecting to gRPC endpoint failed"),
                details: Some(message.to_string())
            }),
            Status::GrpcCallFailed { status } => Ok(StatusMessage {
                message: "gRPC call failed".to_string(),
                details: Some(status.to_string()),
            }),
            Status::GrpcStreamReadFailed {  channel_id, stream_id, element, status  } => Ok(StatusMessage {
                message: format!("reading {} from gRPC stream {} of channel {} failed", match element { GrpcStreamElement::Trailers => "trailers", GrpcStreamElement::Message => "message" }, stream_id, channel_id),
                details: Some(status.to_string())
            }),
            Status::GrpcStreamReadTimedOut { channel_id, stream_id } => Ok(StatusMessage {
                message: format!("reading from gRPC stream {} of channel {} timed out", stream_id, channel_id),
                details: None
            }),
            Status::GrpcStreamIsUnknown { channel_id, stream_id } => Ok(StatusMessage {
                message: format!("gRPC stream {} of channel {} is unknown", stream_id, channel_id),
                details: None
            }),
            Status::GrpcStreamClosed { channel_id, stream_id } => Ok(StatusMessage {
                message: format!("gRPC stream {} of channel {} closed", stream_id, channel_id),
                details: None
            }),
            Status::HttpRequestFailed { stream_id, error } => Ok(StatusMessage {
                message: format!("request for http stream {} failed", stream_id),
                details: Some(error.to_string())
            }),
            Status::HttpStreamReadFailed { stream_id, error } => Ok(StatusMessage {
                message: format!("reading chunk from http stream {} failed", stream_id),
                details: Some(error.to_string())
            }),
            Status::HttpStreamReadTimedOut { stream_id } => Ok(StatusMessage {
                message: format!("reading from http stream {} timed out", stream_id),
                details: None
            }),
            Status::HttpStreamIsUnknown { stream_id } => Ok(StatusMessage {
                message: format!("http stream {} is unknown", stream_id),
                details: None
            }),
            Status::HttpStreamClosed { stream_id } => Ok(StatusMessage {
                message: format!("http stream {} closed", stream_id),
                details: None
            }),
            Status::HttpStreamFailed { stream_id, error } => Ok(StatusMessage {
                message: format!("http stream {} failed", stream_id),
                details: Some(error.to_string())
            }),
            Status::HttpClientConfigInvalid {  message } => Ok(StatusMessage {
                message: format!("http client config is invalid"),
                details: Some(message.to_string())
            }),
            Status::HttpUrlIsInvalid { message } => Ok(StatusMessage {
                message: format!("http url is invalid"),
                details: Some(message.to_string())
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
    fn from(status: &Status) -> Response<Vec<u8>> {
        let grpc_status = match &status {
            // Is a gRPC status?
            Status::GrpcCallFailed { ref status } => status,
            Status::GrpcStreamReadFailed { channel_id: _, stream_id: _, element: _, ref status } => status,
            _ => {
                let mut body: Vec<u8> = Vec::new();
                if let Ok(status_msg) = StatusMessage::try_from(status) {
                    body = serde_json::to_vec(&status_msg).unwrap_or_default();
                }
                return Response::builder()
                    .status(StatusCode::from(status).as_u16())
                    .header(HEADER_NAME_ERROR, "true")
                    .header(CONTENT_TYPE, mime::APPLICATION_JSON.essence_str())
                    .body(body)
                    .unwrap();
            }
        };
        let grpc_code = (grpc_status.code() as usize).to_string();
        let grpc_status_msg = StatusMessage {
            message: grpc_status.message().to_string(),
            details: None,
        };
        let body: Vec<u8> = serde_json::to_vec(&grpc_status_msg).unwrap_or_default();
        Response::builder()
            .status(StatusCode::from(status).as_u16())
            .header(HEADER_NAME_ERROR, "true")
            .header(HEADER_NAME_GRPC_STATUS, &grpc_code)
            .header(CONTENT_TYPE, mime::APPLICATION_JSON.essence_str())
            .body(body)
            .unwrap()
    }
}
