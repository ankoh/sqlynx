//! `dashql-data` — build-artifact indexer + R2 mirror for data.dashql.app.
//!
//! Two subcommands, both operating on a locally-built directory tree (the Bazel
//! `//packages/dashql-data:datasets` artifact — a versioned Parquet tree):
//!
//!   * `index` — walk the tree and emit `index.json`
//!     (`{ dataset -> version -> files[{url,bytes,sha256}] }`). Run inside the
//!     hermetic Bazel build (genrule), so it touches no network.
//!   * `sync`  — mirror the tree to the `dashql-data` R2 bucket: versioned files are
//!     immutable (skip-if-present via HeadObject), `index.json` is always re-put.
//!
//! The mirror is deliberately dumb: it knows nothing about dataset definitions,
//! DuckDB, or fetching. It shares only ~10 lines of S3-client setup with
//! `dashql-pack` (intentionally duplicated, not coupled — see docs/design/test_data.md).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::Serialize;

/// The R2 bucket everything is mirrored into. Immutable versioned paths live here.
const BUCKET: &str = "dashql-data";
/// The one mutable object: always re-uploaded, never skipped.
const INDEX_FILE: &str = "index.json";
/// Completion marker for a folder output. Once uploaded, its entire prefix becomes
/// immutable and future syncs must not merge a rebuilt folder into that version.
const FOLDER_INDEX_FILE: &str = "index.json";

#[derive(Parser, Debug)]
#[command(name = "dashql-data", about = "Indexer + R2 mirror for data.dashql.app")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Walk an assembled dataset tree and emit index.json.
    Index(IndexArgs),
    /// Mirror an assembled dataset tree to the dashql-data R2 bucket.
    Sync(SyncArgs),
    /// Write a recursive file inventory inside a folder artifact.
    FolderIndex(FolderIndexArgs),
}

#[derive(Parser, Debug)]
struct IndexArgs {
    /// The assembled Parquet tree (<dataset>/v<version>/<file>.parquet).
    #[arg(long)]
    dir: PathBuf,
    /// Public base URL the files are served from (used to root index URLs).
    #[arg(long, default_value = "https://data.dashql.app")]
    base_url: String,
    /// Where to write index.json.
    #[arg(long)]
    out: PathBuf,
}

#[derive(Parser, Debug)]
struct SyncArgs {
    /// The built :datasets dir (Parquet tree + index.json).
    #[arg(long)]
    dir: PathBuf,
    /// Print planned uploads without touching R2.
    #[arg(long, default_value_t = false)]
    dry_run: bool,
}

#[derive(Parser, Debug)]
struct FolderIndexArgs {
    /// Folder artifact to index. The index is written inside this directory.
    #[arg(long)]
    dir: PathBuf,
}

/// One entry in the index registry.
#[derive(Serialize)]
struct FileEntry {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

/// A physical file inside a folder artifact. Unlike the top-level registry, folder
/// indexes intentionally use paths relative to their own artifact root.
#[derive(Serialize)]
struct FolderFileEntry {
    path: String,
    bytes: u64,
    sha256: String,
}

fn main() -> Result<()> {
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    env_logger::init();

    let cli = Cli::parse();
    match cli.command {
        Command::Index(args) => run_index(args),
        Command::Sync(args) => run_sync(args),
        Command::FolderIndex(args) => run_folder_index(args),
    }
}

/// Collect every regular file under `dir`, returning `(relative_path, absolute_path)`
/// pairs sorted by relative path so output is deterministic (walkdir order is not).
fn collect_files(dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    // follow_links: inside a Bazel genrule sandbox, copy_to_directory TreeArtifact
    // contents are staged as symlinks; without this every entry is a symlink (not a
    // file) and gets skipped. With it, file_type() reflects the link target.
    for entry in walkdir::WalkDir::new(dir).follow_links(true).sort_by_file_name() {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let rel = abs
            .strip_prefix(dir)
            .with_context(|| format!("path {:?} is not under {:?}", abs, dir))?
            .to_string_lossy()
            .replace('\\', "/");
        files.push((rel, abs));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn sha256_hex(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).with_context(|| format!("read {:?}", path))?;
    let digest = Sha256::digest(&bytes);
    Ok(hex(&digest))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

fn run_index(args: IndexArgs) -> Result<()> {
    // { dataset -> { version -> [FileEntry] } }. BTreeMap for deterministic ordering.
    let mut registry: BTreeMap<String, BTreeMap<String, Vec<FileEntry>>> = BTreeMap::new();
    let base = args.base_url.trim_end_matches('/');
    let files = collect_files(args.dir.as_path())?;

    // A nested index.json represents a complete folder artifact. Its own inventory
    // describes the nested files, so the top-level registry only needs the folder
    // index URL. This also keeps the global registry stable after a completed folder
    // is skipped during a later publication.
    let folder_indexes: Vec<String> = files
        .iter()
        .filter_map(|(rel, _)| {
            (rel != INDEX_FILE && rel.ends_with(&format!("/{FOLDER_INDEX_FILE}")))
                .then(|| rel.clone())
        })
        .collect();

    for (rel, abs) in files {
        if folder_indexes.iter().any(|index| {
            let folder = index.strip_suffix(FOLDER_INDEX_FILE).expect("folder index suffix");
            rel != index.as_str() && rel.starts_with(folder)
        }) {
            continue;
        }
        // Expect <dataset>/v<version>/<file>. Anything else is a layout bug.
        let parts: Vec<&str> = rel.splitn(3, '/').collect();
        if parts.len() != 3 {
            anyhow::bail!(
                "unexpected path layout {:?}; expected <dataset>/v<version>/<file>",
                rel
            );
        }
        let dataset = parts[0].to_string();
        // The directory is `v<version>`; index by the bare version (strip leading 'v').
        let version = parts[1].strip_prefix('v').unwrap_or(parts[1]).to_string();

        let is_folder_index = folder_indexes.iter().any(|index| rel == index.as_str());
        let meta = std::fs::metadata(&abs).with_context(|| format!("stat {:?}", abs))?;
        let entry = FileEntry {
            url: format!("{}/{}", base, rel),
            // Folder indexes are publication references, not stable blobs: Hyper can
            // generate new Iceberg file names on a local rebuild after R2 has already
            // sealed the folder. The folder index URL stays stable; its content hash
            // intentionally does not participate in the mutable global registry.
            bytes: (!is_folder_index).then_some(meta.len()),
            sha256: (!is_folder_index).then(|| sha256_hex(&abs)).transpose()?,
        };
        registry
            .entry(dataset)
            .or_default()
            .entry(version)
            .or_default()
            .push(entry);
    }

    let json = serde_json::to_string_pretty(&registry)?;
    std::fs::write(&args.out, json.as_bytes())
        .with_context(|| format!("write {:?}", args.out))?;
    log::info!("wrote {} datasets to {:?}", registry.len(), args.out);
    Ok(())
}

fn run_folder_index(args: FolderIndexArgs) -> Result<()> {
    let mut files = Vec::new();
    for (rel, abs) in collect_files(args.dir.as_path())? {
        if rel == FOLDER_INDEX_FILE {
            continue;
        }
        let meta = std::fs::metadata(&abs).with_context(|| format!("stat {:?}", abs))?;
        files.push(FolderFileEntry {
            path: rel,
            bytes: meta.len(),
            sha256: sha256_hex(&abs)?,
        });
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({ "files": files }))?;
    let output = args.dir.join(FOLDER_INDEX_FILE);
    std::fs::write(&output, json.as_bytes()).with_context(|| format!("write {:?}", output))?;
    log::info!("wrote folder index to {:?}", output);
    Ok(())
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/// R2 credentials, read from the environment. Mirrors dashql-pack's RemoteAccess but
/// with the DATA (not GET) variable prefix — the two tools stay independent.
struct RemoteAccess {
    r2_endpoint: String,
    r2_access_key_id: String,
    r2_secret_access_key: String,
}

impl RemoteAccess {
    fn from_env() -> Result<RemoteAccess> {
        let var = |name: &str| -> Result<String> {
            let v = std::env::var(name)
                .with_context(|| format!("failed to access environment variable {}", name))?;
            anyhow::ensure!(!v.is_empty(), "environment variable {} is empty", name);
            Ok(v)
        };
        Ok(RemoteAccess {
            r2_endpoint: var("DASHQL_DATA_R2_ENDPOINT")?,
            r2_access_key_id: var("DASHQL_DATA_R2_ACCESS_KEY_ID")?,
            r2_secret_access_key: var("DASHQL_DATA_R2_SECRET_ACCESS_KEY")?,
        })
    }

    fn get_credentials(&self) -> aws_credential_types::Credentials {
        aws_credential_types::Credentials::new(
            self.r2_access_key_id.clone(),
            self.r2_secret_access_key.clone(),
            None,
            None,
            "r2",
        )
    }
}

/// Content-type by file extension. Cosmetic for Hyper (which reads by content), but
/// makes curl/browser downloads behave. Outputs can be any format the dataset SQL
/// writes (parquet, csv, …), so map on the extension rather than assuming parquet.
fn content_type_for(key: &str) -> &'static str {
    match key.rsplit('.').next() {
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("parquet") => "application/vnd.apache.parquet",
        _ => "application/octet-stream",
    }
}

#[tokio::main(flavor = "current_thread")]
async fn run_sync(args: SyncArgs) -> Result<()> {
    let mut files = collect_files(args.dir.as_path())?;
    if files.is_empty() {
        anyhow::bail!("no files found under {:?}", args.dir);
    }
    // Folder indexes mark their folders complete, so write them after the files they
    // inventory. The global index follows every artifact completion marker.
    files.sort_by_key(|(key, _)| {
        let rank = if key == INDEX_FILE {
            2
        } else if key.ends_with(&format!("/{FOLDER_INDEX_FILE}")) {
            1
        } else {
            0
        };
        (rank, key.clone())
    });

    if args.dry_run {
        log::info!("DRY RUN, no uploads will be made");
        for (key, _) in &files {
            if let Some(folder) = key.strip_suffix(&format!("/{FOLDER_INDEX_FILE}")) {
                log::info!("  DELETE stale objects under s3://{}/{}/ if folder index is absent", BUCKET, folder);
            }
        }
        for (key, _) in &files {
            let action = if key == INDEX_FILE {
                "PUT (always)"
            } else if key.ends_with(&format!("/{FOLDER_INDEX_FILE}")) {
                "PUT folder completion marker if absent"
            } else {
                "PUT if folder incomplete and file absent"
            };
            log::info!("  {} -> s3://{}/{}", action, BUCKET, key);
        }
        log::info!("{} files planned", files.len());
        return Ok(());
    }

    // Build the R2 client (same shape as dashql-pack's publish_command.rs).
    let remote_access = RemoteAccess::from_env()?;
    log::info!("r2 bucket: {} (endpoint/key/secret from environment)", BUCKET);
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
    let client = aws_sdk_s3::Client::from_conf(r2_config);

    // Check every folder completion marker before uploading any folder contents. A
    // marker means the versioned folder was published atomically enough to advertise
    // and must never be merged with a later, non-deterministic build.
    let mut complete_folders = std::collections::BTreeSet::new();
    for (key, _) in &files {
        if let Some(folder) = key.strip_suffix(&format!("/{FOLDER_INDEX_FILE}")) {
            if object_exists(&client, key).await? {
                log::info!("folder already complete: {}", folder);
                complete_folders.insert(folder.to_string());
            }
        }
    }

    // A missing folder index means a prior publication did not complete. Remove any
    // partial generation before uploading the current one so random Iceberg file
    // names can never be merged across builds. A present index is never touched.
    for (key, _) in &files {
        if let Some(folder) = key.strip_suffix(&format!("/{FOLDER_INDEX_FILE}")) {
            if !complete_folders.contains(folder) {
                delete_prefix(&client, &format!("{folder}/")).await?;
            }
        }
    }

    let (mut uploaded, mut skipped) = (0u64, 0u64);
    for (key, abs) in &files {
        if complete_folders.iter().any(|folder| key.starts_with(&format!("{folder}/"))) {
            log::info!("skip (folder complete) {}", key);
            skipped += 1;
            continue;
        }
        // Versioned files are immutable: skip if already present. index.json is mutable.
        if key != INDEX_FILE && object_exists(&client, key).await? {
            log::info!("skip (present) {}", key);
            skipped += 1;
            continue;
        }
        let body = aws_sdk_s3::primitives::ByteStream::from_path(abs)
            .await
            .with_context(|| format!("open {:?} for upload", abs))?;
        client
            .put_object()
            .bucket(BUCKET)
            .key(key)
            .content_type(content_type_for(key))
            .body(body)
            .send()
            .await
            .with_context(|| format!("put_object {}", key))?;
        log::info!("put {}", key);
        uploaded += 1;
    }
    log::info!("done: {} uploaded, {} skipped", uploaded, skipped);
    Ok(())
}

/// HeadObject on the bucket: Ok(true) if present, Ok(false) if 404, Err otherwise.
async fn object_exists(client: &aws_sdk_s3::Client, key: &str) -> Result<bool> {
    match client.head_object().bucket(BUCKET).key(key).send().await {
        Ok(_) => Ok(true),
        Err(e) => {
            let svc = e.into_service_error();
            if svc.is_not_found() {
                Ok(false)
            } else {
                Err(anyhow::Error::new(svc).context(format!("head_object {}", key)))
            }
        }
    }
}

/// Delete every object below an incomplete folder output. R2 has no directories, so
/// this lists and deletes object keys with the folder's slash-terminated prefix.
async fn delete_prefix(client: &aws_sdk_s3::Client, prefix: &str) -> Result<()> {
    let mut continuation_token = None;
    let mut deleted = 0usize;
    loop {
        let result = client
            .list_objects_v2()
            .bucket(BUCKET)
            .prefix(prefix)
            .set_continuation_token(continuation_token)
            .send()
            .await
            .with_context(|| format!("list_objects_v2 {prefix}"))?;
        let keys: Vec<_> = result
            .contents()
            .iter()
            .filter_map(|object| object.key())
            .map(|key| aws_sdk_s3::types::ObjectIdentifier::builder().key(key).build())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for chunk in keys.chunks(1000) {
            client
                .delete_objects()
                .bucket(BUCKET)
                .delete(aws_sdk_s3::types::Delete::builder().set_objects(Some(chunk.to_vec())).build()?)
                .send()
                .await
                .with_context(|| format!("delete_objects {prefix}"))?;
            deleted += chunk.len();
        }
        continuation_token = result.next_continuation_token().map(str::to_owned);
        if continuation_token.is_none() {
            break;
        }
    }
    if deleted > 0 {
        log::info!("deleted {} stale objects under {}", deleted, prefix);
    }
    Ok(())
}
