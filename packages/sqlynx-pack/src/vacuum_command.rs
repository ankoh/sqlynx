use anyhow::Result;
use clap::Parser;
use semver::Version;
use std::collections::HashMap;

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

    let results = r2_client
        .list_objects_v2()
        .bucket("sqlynx-get")
        .prefix("releases/")
        .send()
        .await?;

    let versions = results
        .contents()
        .iter()
        .filter(|entry| entry.key().is_some())
        .map(|entry| {
            let mut p = entry.key().unwrap();
            p = p.strip_prefix("releases/").unwrap_or(p);
            p = &p[..p.find('/').unwrap_or(p.len())];
            (semver::Version::parse(p), entry)
        })
        .filter(|(version, _entry)| version.is_ok())
        .map(|(version, entry)| (version.unwrap(), entry));

    let mut stable_objects: HashMap<Version, Vec<&aws_sdk_s3::types::Object>> = HashMap::new();
    let mut canary_objects: HashMap<Version, Vec<&aws_sdk_s3::types::Object>> = HashMap::new();
    for (version, object) in versions {
        if version.pre.is_empty() {
            let objects = stable_objects.entry(version).or_insert_with(|| Vec::new());
            objects.push(object);
        } else {
            let objects = canary_objects.entry(version).or_insert_with(|| Vec::new());
            objects.push(object);
        }
    }

    let mut canary_versions: Vec<Version> = canary_objects.keys().cloned().collect();
    let mut stable_versions: Vec<Version> = stable_objects.keys().cloned().collect();
    canary_versions.sort_by(|a, b| b.cmp(a));
    stable_versions.sort_by(|a, b| b.cmp(a));

    let (keep_canary, delete_canary) =
        canary_versions.split_at(args.keep_canary.min(canary_versions.len()));
    let (keep_stable, delete_stable) =
        stable_versions.split_at(args.keep_stable.min(stable_versions.len()));

    log::info!("keep canary versions: {:?}", keep_canary);
    log::info!("keep stable versions: {:?}", keep_stable);
    log::info!("delete stable versions: {:?}", delete_stable);
    log::info!("delete canary versions: {:?}", delete_canary);

    let mut delete_objects: Vec<aws_sdk_s3::types::ObjectIdentifier> = vec![];
    for v in delete_canary.iter() {
        canary_objects
            .get(v)
            .unwrap()
            .iter()
            .map(|o| {
                aws_sdk_s3::types::ObjectIdentifier::builder()
                    .set_key(Some(o.key().unwrap().to_string()))
                    .build()
                    .unwrap()
            })
            .for_each(|o| delete_objects.push(o));
    }
    for v in delete_stable.iter() {
        canary_objects
            .get(v)
            .unwrap()
            .iter()
            .map(|o| {
                aws_sdk_s3::types::ObjectIdentifier::builder()
                    .set_key(Some(o.key().unwrap().to_string()))
                    .build()
                    .unwrap()
            })
            .for_each(|o| delete_objects.push(o));
    }
    log::info!("delete objects: {:?}", delete_objects);

    if !args.dry_run && !delete_objects.is_empty() {
        let objects = aws_sdk_s3::types::Delete::builder()
            .set_objects(Some(delete_objects))
            .build()?;
        r2_client
            .delete_objects()
            .bucket("sqlynx-get")
            .delete(objects)
            .send()
            .await?;
        log::info!("deleted objects");
    }

    Ok(())
}
