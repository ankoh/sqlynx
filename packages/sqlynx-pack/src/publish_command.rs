use crate::{
    git_info::collect_git_info,
    release::{Release, ReleaseArgs},
    release_version::build_release_version,
    remote_access::RemoteAccess,
};

use anyhow::Result;
use clap::Parser;
use std::io::Write;
use std::path::PathBuf;

#[derive(Parser, Debug)]
pub struct PublishArgs {
    #[arg(long, required = false, default_value = "false")]
    dry_run: bool,
    #[arg(long, required = false)]
    save_metadata: Option<PathBuf>,
}

pub async fn publish(args: PublishArgs) -> Result<()> {
    // Is a dry-run?
    if args.dry_run {
        log::info!("DRY RUN, no persistent changes will be made");
    }

    // Resolve the git version
    let source_dir = std::env::current_dir()?;
    let git_repo = collect_git_info(&source_dir)?;
    log::info!("git description: {}", &git_repo.version.description);

    let version = build_release_version(&git_repo.version)?;
    log::info!("release version: {}", &version.version);
    log::info!("release id: {}", &version.id);
    log::info!("release channel: {}", &version.channel);

    // Build the release
    let rel = Release::build(ReleaseArgs {
        remote_base_url: "https://get.sqlynx.app".to_string(),
        source_dir,
        git_repo,
        release_version: version,
    })
    .await?;

    // Check R2 credentials
    let remote_access = RemoteAccess::from_env()?;
    log::info!("r2 bucket: **** (from environment)");
    log::info!("r2 access key id: **** (from environment)");
    log::info!("r2 secret access key: **** (from environment)");

    // Build r2 client
    let r2_credentials = remote_access.get_credentials();
    let r2_region = aws_config::Region::new("auto");
    let r2_credential_provider =
        aws_credential_types::provider::SharedCredentialsProvider::new(r2_credentials);
    let r2_config = aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .endpoint_url(remote_access.r2_endpoint)
        .region(r2_region)
        .credentials_provider(r2_credential_provider)
        .build();
    let r2_client = aws_sdk_s3::Client::from_conf(r2_config);

    // Write the metadata (if requested)
    if let Some(path) = &args.save_metadata {
        let file = std::fs::File::create(path)?;
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, &rel.release_metadata)?;
        writer.flush()?;
        log::info!("wrote release metadata to: {:?}", &path.as_path());
    }

    // Publish the release
    if !args.dry_run {
        rel.publish(&r2_client).await?;
    }
    Ok(())
}
