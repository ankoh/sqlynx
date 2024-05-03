use std::fmt::{Display, Formatter, Error};

use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};

#[derive(Debug)]
pub enum GrpcStreamElement {
    Message,
    Trailers,
}

#[derive(Debug)]
pub enum Status {
    HeaderHasInvalidEncoding{ header: &'static str, message: String },
    HeaderRequiredButMissing{ header: &'static str },
    HeaderIsNotAValidEndpoint{ header: &'static str, message: String },
    HeaderIsNotAnUsize{ header: &'static str, message: String },
    HeaderPathIsInvalid{ header: &'static str, path: String, message: String },
    GrpcChannelIdIsUnknown{ channel_id: usize },
    GrpcEndpointConnectFailed{ message: String },
    GrpcCallFailed{ status: tonic::Status },
    GrpcStreamReadFailed { channel_id: usize, stream_id: usize, element: GrpcStreamElement, status: tonic::Status },
    GrpcStreamReadTimedOut { channel_id: usize, stream_id: usize },
    GrpcStreamIsUnknown { channel_id: usize, stream_id: usize },
    GrpcStreamClosed { channel_id: usize, stream_id: usize },
    HttpRequestFailed { stream_id: usize, error: String },
    HttpStreamReadFailed { stream_id: usize, error: String },
    HttpStreamReadTimedOut { stream_id: usize },
    HttpStreamIsUnknown { stream_id: usize },
    HttpStreamClosed { stream_id: usize },
    HttpStreamFailed { stream_id: usize, error: String }
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
        }
    }
}

impl From<&Status> for StatusCode {
    fn from(status: &Status) -> StatusCode {
        match status {
            Status::HeaderHasInvalidEncoding { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderIsNotAValidEndpoint { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderRequiredButMissing { header: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderIsNotAnUsize { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderPathIsInvalid { header: _, path: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcChannelIdIsUnknown { channel_id: _ } => StatusCode::NOT_FOUND,
            Status::GrpcEndpointConnectFailed { message: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcCallFailed { status: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamReadFailed { channel_id: _, stream_id: _, element: _, status: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamReadTimedOut { channel_id: _, stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcStreamIsUnknown { channel_id: _, stream_id: _ } => StatusCode::NOT_FOUND,
            Status::GrpcStreamClosed { channel_id: _, stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HttpRequestFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamReadFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamReadTimedOut { stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamIsUnknown { stream_id: _ } => StatusCode::NOT_FOUND,
            Status::HttpStreamClosed { stream_id: _ } => StatusCode::BAD_REQUEST,
            Status::HttpStreamFailed { stream_id: _, error: _ } => StatusCode::BAD_REQUEST,
        }
    }
}

impl From<&Status> for Response<Vec<u8>> {
    fn from(status: &Status) -> Response<Vec<u8>> {
        let message = status.to_string();
        Response::builder()
            .status(StatusCode::from(status).as_u16())
            .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
            .body(message.as_bytes().to_vec())
            .unwrap()

    }
}
