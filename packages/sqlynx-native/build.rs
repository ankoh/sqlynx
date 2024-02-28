fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure().out_dir("src/proto/").compile(
        &["../../proto/pb/salesforce/hyperdb/grpc/v1/hyper_service.proto"],
        &["../../proto/pb/"],
    )?;
    tauri_build::build();
    Ok(())
}
