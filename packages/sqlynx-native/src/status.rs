use std::fmt::{Display, Formatter, Error};

use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};

use crate::proxy_headers::HEADER_NAME_GRPC_STATUS;

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

impl Display for Status {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), Error> {
        match self {
            Status::HeaderHasInvalidEncoding { header, message } => {
                f.write_fmt(format_args!("header '{}' has an invalid encoding: {}", header, message))
            }
            Status::HeaderIsNotAValidEndpoint { header, message } => {
                f.write_fmt(format_args!("header '{}' is not a valid endpoint: {}", header, message))
            }
            Status::HeaderRequiredButMissing { header } => {
                f.write_fmt(format_args!("header '{}' is missing", header))
            }
            Status::HeaderIsNotAnUsize { header, message } => {
                f.write_fmt(format_args!("header '{}' is not an unsigned integer: {}", header, message))
            }
            Status::HeaderPathIsInvalid { header, path, message } => {
                f.write_fmt(format_args!("header '{}' stores the path '{}' and is invalid: {}", header, path, message))
            }
            Status::HttpEndpointIsInvalid { header, endpoint, message } => {
                f.write_fmt(format_args!("header '{}' stores endpoint '{}' which is invalid: {}", header, endpoint, message))
            }
            Status::HttpMethodIsInvalid { header, method, message } => {
                f.write_fmt(format_args!("header '{}' stores method '{}' which is invalid: {}", header, method, message))
            }
            Status::GrpcChannelIdIsUnknown { channel_id } => {
                f.write_fmt(format_args!("gRPC channel id {} is unknown", channel_id))
            }
            Status::GrpcEndpointConnectFailed { message } => {
                f.write_fmt(format_args!("connecting to gRPC endpoint failed with error: {}", message))
            }
            Status::GrpcCallFailed { status } => {
                f.write_fmt(format_args!("gRPC call failed with error: {}", status.to_string()))
            }
            Status::GrpcStreamReadFailed {  channel_id, stream_id, element, status  } => {
                f.write_fmt(format_args!("reading {} from gRPC stream {} of channel {} failed with error: {}", match element { GrpcStreamElement::Trailers => "trailers", GrpcStreamElement::Message => "message" }, stream_id, channel_id, status.to_string()))
            }
            Status::GrpcStreamReadTimedOut { channel_id, stream_id } => {
                f.write_fmt(format_args!("reading from gRPC stream {} of channel {} timed out", stream_id, channel_id))
            }
            Status::GrpcStreamIsUnknown { channel_id, stream_id } => {
                f.write_fmt(format_args!("gRPC stream {} of channel {} is unknown", stream_id, channel_id))
            }
            Status::GrpcStreamClosed { channel_id, stream_id } => {
                f.write_fmt(format_args!("gRPC stream {} of channel {} closed", stream_id, channel_id))
            }
            Status::HttpRequestFailed { stream_id, error } => {
                f.write_fmt(format_args!("request for http stream {} failed with error: {}", stream_id, error))
            }
            Status::HttpStreamReadFailed { stream_id, error } => {
                f.write_fmt(format_args!("reading chunk from http stream {} failed with error: {}", stream_id, error))
            }
            Status::HttpStreamReadTimedOut { stream_id } => {
                f.write_fmt(format_args!("reading from http stream {} timed out", stream_id))
            }
            Status::HttpStreamIsUnknown { stream_id } => {
                f.write_fmt(format_args!("http stream {} is unknown", stream_id))
            }
            Status::HttpStreamClosed { stream_id } => {
                f.write_fmt(format_args!("http stream {} closed", stream_id))
            }
            Status::HttpStreamFailed { stream_id, error } => {
                f.write_fmt(format_args!("http stream {} failed with error: {}", stream_id, error))
            }
            Status::HttpClientConfigInvalid {  message } => {
                f.write_fmt(format_args!("http client config is invalid: {}", message))
            }
            Status::HttpUrlIsInvalid { message } => {
                f.write_fmt(format_args!("http url is invalid : {}", message))
            }
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
            Status::GrpcCallFailed { ref status } => status,
            Status::GrpcStreamReadFailed { channel_id: _, stream_id: _, element: _, ref status } => status,
            _ => {
                let message = status.to_string();
                return Response::builder()
                    .status(StatusCode::from(status).as_u16())
                    .header(HEADER_NAME_GRPC_STATUS, 13)
                    .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
                    .body(message.as_bytes().to_vec())
                    .unwrap();
            }
        };
        let code = (grpc_status.code() as usize).to_string();
        Response::builder()
            .status(StatusCode::from(status).as_u16())
            .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
            .header(HEADER_NAME_GRPC_STATUS, &code)
            .body(grpc_status.message().as_bytes().to_vec())
            .unwrap()
    }
}
