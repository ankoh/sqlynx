use std::fmt::{Display, Formatter, Error};

use tauri::http::StatusCode;

pub enum Status {
    HeaderHasInvalidEncoding{ header: &'static str, message: String },
    HeaderRequiredButMissing{ header: &'static str },
    HeaderIsNotAValidEndpoint{ header: &'static str, message: String },
    HeaderIsNotANumber{ header: &'static str, message: String },
    HeaderChannelIdIsUnknown{ header: &'static str, channel_id: usize },
    HeaderPathIsInvalid{ header: &'static str, path: String, message: String },
    EndpointConnectFailed{ message: String },
    GrpcCallFailed{ status: tonic::Status },
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
            Status::HeaderIsNotANumber { header, message } => {
                f.write_fmt(format_args!("header '{}' is not a number: {}", header, message))
            }
            Status::HeaderChannelIdIsUnknown { header, channel_id } => {
                f.write_fmt(format_args!("header '{}' refers to unknown channel with id {}", header, channel_id))
            }
            Status::HeaderPathIsInvalid { header, path, message } => {
                f.write_fmt(format_args!("header '{}' stores the path '{}' and is invalid: {}", header, path, message))
            }
            Status::EndpointConnectFailed { message } => {
                f.write_fmt(format_args!("connecting to endpoint failed with error: {}", message))
            }
            Status::GrpcCallFailed { status } => {
                f.write_fmt(format_args!("gRPC call failed with error: {}", status.to_string()))
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
            Status::HeaderIsNotANumber { header: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderChannelIdIsUnknown { header: _, channel_id: _ } => StatusCode::BAD_REQUEST,
            Status::HeaderPathIsInvalid { header: _, path: _, message: _ } => StatusCode::BAD_REQUEST,
            Status::EndpointConnectFailed { message: _ } => StatusCode::BAD_REQUEST,
            Status::GrpcCallFailed { status: _ } => StatusCode::BAD_REQUEST,
        }
    }

}
