use anyhow::Result;
use clap::Parser;
use semver::Version;

use crate::remote_access::RemoteAccess;

#[derive(Parser, Debug)]
pub struct VacuumArgs {
    #[arg(long, required = false, default_value = "false")]
    dry_run: bool,
    #[arg(long, required = true)]
    keep_canary: usize,
    #[arg(long, required = true)]
    keep_stable: usize,
}

pub async fn vacuum(args: VacuumArgs) -> Result<()> {
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

    let results = r2_client
        .list_objects_v2()
        .bucket("sqlynx-get")
        .prefix("releases/")
        .delimiter("/")
        .send()
        .await?;

    let versions: Vec<Version> = results
        .common_prefixes()
        .iter()
        .map(|p| p.prefix())
        .filter(|p| p.is_some())
        .map(|p| {
            let mut p = p.unwrap();
            p = p.strip_prefix("releases/").unwrap_or(p);
            p = p.strip_suffix("/").unwrap_or(p);
            semver::Version::parse(p)
        })
        .filter(|p| p.is_ok())
        .map(|p| p.unwrap())
        .collect();

    let mut canary_versions: Vec<Version> = versions
        .iter()
        .filter(|v| !v.pre.is_empty())
        .cloned()
        .collect();
    let mut stable_versions: Vec<Version> = versions
        .iter()
        .filter(|v| v.pre.is_empty())
        .cloned()
        .collect();
    canary_versions.sort_by(|a, b| b.cmp(a));
    stable_versions.sort_by(|a, b| b.cmp(a));

    let (keep_canary, delete_canary) =
        canary_versions.split_at(args.keep_canary.min(canary_versions.len()));
    let (keep_stable, delete_stable) =
        stable_versions.split_at(args.keep_stable.min(stable_versions.len()));

    log::info!("canary keep: {:?}", keep_canary);
    log::info!("canary delete: {:?}", delete_canary);
    log::info!("stable keep: {:?}", keep_stable);
    log::info!("stable delete: {:?}", delete_stable);
    Ok(())
}
