fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure().compile(
        &["../../proto/pb/salesforce/hyperdb/grpc/v1/hyper_service.proto"],
        &["../../proto/pb/"],
    )?;
    tauri_build::build();
    Ok(())
}
