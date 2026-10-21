use anyhow::Result;
use clap::Parser;
use semver::Version;
use std::collections::HashMap;

use crate::remote_access::RemoteAccess;

/// Delete all but the newest release versions from R2
#[derive(Parser, Debug)]
pub struct VacuumArgs {
    /// List the objects to delete without deleting them
    #[arg(long, required = false, default_value = "false")]
    dry_run: bool,
    /// The number of newest canary versions to keep
    #[arg(long, required = false, default_value_t = 10)]
    keep_canary: usize,
    /// The number of newest stable versions to keep
    #[arg(long, required = false, default_value_t = 100)]
    keep_stable: usize,
}

fn retained_versions(mut versions: Vec<Version>, keep: usize) -> (Vec<Version>, Vec<Version>) {
    versions.sort_by(|a, b| b.cmp(a));
    let deleted = versions.split_off(keep.min(versions.len()));
    (versions, deleted)
}

pub async fn vacuum(args: VacuumArgs) -> Result<()> {
    // Is a dry-run?
    if args.dry_run {
        log::info!("DRY RUN, no persistent changes will be made");
    }

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

    let mut stable_objects: HashMap<Version, Vec<String>> = HashMap::new();
    let mut canary_objects: HashMap<Version, Vec<String>> = HashMap::new();
    let mut continuation_token: Option<String> = None;
    loop {
        let results = r2_client
            .list_objects_v2()
            .bucket("dashql-get")
            .prefix("releases/")
            .set_continuation_token(continuation_token)
            .send()
            .await?;
        for key in results.contents().iter().filter_map(|entry| entry.key()) {
            let relative = key.strip_prefix("releases/").unwrap_or(key);
            let version_text = &relative[..relative.find('/').unwrap_or(relative.len())];
            let Ok(version) = semver::Version::parse(version_text) else { continue };
            let objects = if version.pre.is_empty() {
                stable_objects.entry(version).or_default()
            } else {
                canary_objects.entry(version).or_default()
            };
            objects.push(key.to_string());
        }
        continuation_token = results.next_continuation_token().map(str::to_owned);
        if continuation_token.is_none() { break; }
    }

    let (keep_canary, delete_canary) = retained_versions(canary_objects.keys().cloned().collect(), args.keep_canary);
    let (keep_stable, delete_stable) = retained_versions(stable_objects.keys().cloned().collect(), args.keep_stable);

    log::info!("keep canary versions: {:?}", keep_canary);
    log::info!("keep stable versions: {:?}", keep_stable);
    log::info!("delete stable versions: {:?}", delete_stable);
    log::info!("delete canary versions: {:?}", delete_canary);

    let mut delete_objects: Vec<aws_sdk_s3::types::ObjectIdentifier> = vec![];
    for v in &delete_canary {
        canary_objects
            .get(v)
            .unwrap()
            .iter()
            .map(|key| {
                aws_sdk_s3::types::ObjectIdentifier::builder()
                    .set_key(Some(key.clone()))
                    .build()
                    .unwrap()
            })
            .for_each(|o| delete_objects.push(o));
    }
    for v in &delete_stable {
        stable_objects
            .get(v)
            .unwrap()
            .iter()
            .map(|key| {
                aws_sdk_s3::types::ObjectIdentifier::builder()
                    .set_key(Some(key.clone()))
                    .build()
                    .unwrap()
            })
            .for_each(|o| delete_objects.push(o));
    }
    log::info!("delete objects: {:?}", delete_objects);

    if !args.dry_run {
        for chunk in delete_objects.chunks(1000) {
            let objects = aws_sdk_s3::types::Delete::builder()
                .set_objects(Some(chunk.to_vec()))
                .build()?;
            let result = r2_client
                .delete_objects()
                .bucket("dashql-get")
                .delete(objects)
                .send()
                .await?;
            if !result.errors().is_empty() {
                return Err(anyhow::anyhow!("R2 failed to delete objects: {:?}", result.errors()));
            }
            log::info!("deleted {} objects", chunk.len());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_keeps_newest_versions() {
        let versions = ["1.0.0-dev.1", "1.0.0-dev.3", "1.0.0-dev.2"]
            .into_iter().map(|value| Version::parse(value).unwrap()).collect();
        let (keep, delete) = retained_versions(versions, 2);
        assert_eq!(keep, vec![Version::parse("1.0.0-dev.3").unwrap(), Version::parse("1.0.0-dev.2").unwrap()]);
        assert_eq!(delete, vec![Version::parse("1.0.0-dev.1").unwrap()]);
    }
}
