//! Generates the protobuf messages and tonic services that the unit tests run against.
//!
//! Only `:test` runs this script, the proxy itself forwards opaque message bytes.

/// The path of the Hyper service proto below the proto root
const HYPER_SERVICE_PROTO: &str = "salesforce/hyperdb/grpc/v1/hyper_service.proto";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let hyper_service = std::env::var("PROTO_HYPER_SERVICE").expect("PROTO_HYPER_SERVICE");
    let test_service = std::env::var("PROTO_TEST_SERVICE").expect("PROTO_TEST_SERVICE");
    let include = hyper_service
        .strip_suffix(HYPER_SERVICE_PROTO)
        .expect("PROTO_HYPER_SERVICE lies below the proto root")
        .to_string();
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&[hyper_service, test_service], &[include])?;
    Ok(())
}
