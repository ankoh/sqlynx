use aws_sdk_s3::primitives::ByteStream;
use chrono::prelude::*;
use futures::StreamExt;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::{
    git_info::GitInfo,
    release_metadata::{
        Architecture, Bundle, BundleTarget, BundleType, Platform, ReleaseMetadata, UpdateArtifact,
        UpdateManifest,
    },
    release_version::ReleaseVersion,
    remote_paths::derive_remote_paths,
};

#[derive(Debug)]
pub struct FileUpload {
    pub source_path: PathBuf,
    pub remote_path: String,
}

#[derive(Default, Debug)]
pub struct Release {
    pub file_uploads: HashMap<String, FileUpload>,
    pub release_metadata: ReleaseMetadata,
    pub release_metadata_path: String,
    pub release_update_manifest: UpdateManifest,
    pub release_update_manifest_path: String,
    pub channel_metadata_paths: Vec<&'static str>,
    pub channel_update_manifest_paths: Vec<&'static str>,
}

pub struct ReleaseArgs {
    pub remote_base_url: String,
    pub source_dir: PathBuf,
    pub git_repo: GitInfo,
    pub release_version: ReleaseVersion,
}

// Find first file that roughly matches `DashQL_0.1.0_universal.dmg`
fn find_dmg_in(dir: &PathBuf) -> Option<PathBuf> {
    let dir_entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_e) => return None,
    };
    for dir_entry_access in dir_entries {
        if let Ok(dir_entry) = dir_entry_access {
            let dir_entry_path = dir_entry.path();
            if !dir_entry_path.is_file() {
                continue;
            }
            let file_name = dir_entry_path.file_name().unwrap();
            let file_name_str = file_name.to_str().unwrap_or_default();
            if file_name_str.starts_with("DashQL_") && file_name_str.ends_with("_universal.dmg") {
                return Some(dir_entry_path);
            }
        }
    }
    None
}

impl Release {
    pub async fn build(args: ReleaseArgs) -> anyhow::Result<Self> {
        let remote_paths = derive_remote_paths(&args.release_version);

        let mut release = Release::default();
        let pub_date = Utc::now();

        // Prepare release metadata
        release.release_metadata_path = remote_paths.release_metadata.clone();
        release.release_metadata.release_id = args.release_version.id.to_string();
        release.release_metadata.version = args.release_version.version.clone();
        release.release_metadata.pub_date = pub_date.clone();
        release.release_metadata.update_manifest_url = format!(
            "{}/{}",
            &args.remote_base_url,
            remote_paths.release_update.clone()
        );
        release.release_metadata.git_commit_hash = args.git_repo.version.short_hash.clone();
        release.release_metadata.git_commit_url = format!(
            "https://github.com/ankoh/dashql/tree/{}",
            &args.git_repo.version.short_hash
        );

        // Prepare update manifest
        release.release_update_manifest_path = remote_paths.release_update.clone();
        release.release_update_manifest.version = args.release_version.version.clone();
        release.release_update_manifest.pub_date = pub_date;
        release.release_update_manifest.notes = "".to_string(); // XXX Get from commit info

        // Prepare channel paths
        release.channel_metadata_paths = remote_paths.channel_metadata.clone();
        release.channel_update_manifest_paths = remote_paths.channel_update.clone();

        // Register macOS .dmg
        let macos_universal_dir = args
            .source_dir
            .join("target")
            .join("universal-apple-darwin")
            .join("release")
            .join("bundle")
            .join("dmg");
        if let Some(dmg_path) = find_dmg_in(&macos_universal_dir) {
            let remote_path = format!("{}/macos/DashQL.dmg", remote_paths.release_directory);
            let remote_url = format!("{}/{}", &args.remote_base_url, remote_path);
            let bundle = Bundle {
                url: remote_url.clone(),
                signature: None,
                name: "DashQL.dmg".to_string(),
                bundle_type: BundleType::Dmg,
                targets: vec![
                    BundleTarget {
                        platform: Platform::Darwin,
                        arch: Architecture::X86_64,
                    },
                    BundleTarget {
                        platform: Platform::Darwin,
                        arch: Architecture::Aarch64,
                    },
                ],
            };

            // Create upload task
            let upload_task = FileUpload {
                source_path: dmg_path,
                remote_path: remote_path.clone(),
            };
            release
                .file_uploads
                .insert(remote_path.clone(), upload_task);

            // Register release artifact
            release.release_metadata.bundles.push(bundle);
        }

        // Register macOS tauri update
        let macos_universal_update_dir = args
            .source_dir
            .join("target")
            .join("release")
            .join("bundle")
            .join("macos");
        let macos_universal_update_app = macos_universal_update_dir.join("DashQL.app.tar.gz");
        if macos_universal_update_app.is_file() {
            let remote_path = format!("{}/macos/DashQL.app.tar.gz", remote_paths.release_directory);
            let remote_url = format!("{}/{}", &args.remote_base_url, &remote_path);
            let sig_path = macos_universal_update_dir.join("DashQL.app.tar.gz.sig");
            let sig = if sig_path.is_file() {
                Some(std::fs::read_to_string(sig_path)?)
            } else {
                None
            };
            let update_artifact = UpdateArtifact {
                url: remote_url.clone(),
                signature: sig.unwrap_or_default(),
            };

            // Create upload task
            let upload_task = FileUpload {
                source_path: macos_universal_update_app.clone(),
                remote_path: remote_path.clone(),
            };
            release
                .file_uploads
                .insert(remote_path.clone(), upload_task);

            // Register artifacts
            release.release_update_manifest.platforms.insert(
                BundleTarget {
                    platform: Platform::Darwin,
                    arch: Architecture::X86_64,
                },
                update_artifact.clone(),
            );
            release.release_update_manifest.platforms.insert(
                BundleTarget {
                    platform: Platform::Darwin,
                    arch: Architecture::Aarch64,
                },
                update_artifact.clone(),
            );
        }

        log::info!("{:?}", &release);
        Ok(release)
    }

    pub async fn publish(&self, client: &aws_sdk_s3::Client) -> anyhow::Result<()> {
        // Serialize release metadata and update manifest and abort after serialization errors
        let release_metadata = serde_json::to_string_pretty(&self.release_metadata)?
            .as_bytes()
            .to_vec();
        let update_manifest = serde_json::to_string_pretty(&self.release_update_manifest)?
            .as_bytes()
            .to_vec();

        // Collect json file uploads
        let mut pending_uploads = vec![
            (self.release_metadata_path.clone(), &release_metadata),
            (self.release_update_manifest_path.clone(), &update_manifest),
        ];

        // Spawn json uploads for release files
        let mut upload_futures = futures::stream::FuturesUnordered::new();
        for (path, metadata) in pending_uploads.drain(..) {
            let path = path.clone();
            let bytes = ByteStream::from(metadata.to_vec());
            let client = client.clone();
            log::info!("upload started, path={}", &path);
            upload_futures.push(tokio::spawn(async move {
                client
                    .put_object()
                    .bucket("dashql-get")
                    .key(&path)
                    .body(bytes)
                    .content_type("application/json")
                    .send()
                    .await
                    .map_err(|e| (path.clone(), e))
                    .map(|_| path.clone())
            }));
        }

        // Spawn file uploads
        for (_, file_upload) in self.file_uploads.iter() {
            let path = file_upload.remote_path.clone();
            let bytes = ByteStream::from_path(file_upload.source_path.clone()).await?;
            let client = client.clone();
            log::info!("upload started, path={}", &path);
            upload_futures.push(tokio::spawn(async move {
                client
                    .put_object()
                    .bucket("dashql-get")
                    .key(&path)
                    .body(bytes)
                    .content_type("application/octet-stream")
                    .send()
                    .await
                    .map_err(|e| (path.clone(), e))
                    .map(|_| path.clone())
            }));
        }

        // Join all uploads
        let mut upload_error: Option<anyhow::Error> = None;
        while let Some(next) = upload_futures.next().await {
            match next {
                Ok(Ok(path)) => {
                    log::info!("upload finished, path={}", &path);
                }
                Ok(Err((path, e))) => {
                    log::error!("upload failed, path={}, error={}", &path, &e);
                    upload_error = Some(e.into());
                }
                Err(e) => {
                    log::error!("failed to join upload task, error={}", &e);
                    upload_error = Some(anyhow::format_err!(
                        "failed to join upload task, error={}",
                        &e
                    ));
                }
            }
        }
        // Don't update the top-level release metadata if any of the release uploads failed
        if let Some(e) = upload_error {
            return Err(e);
        }

        // Now update the release manifests
        for channel_metadata_path in self.channel_metadata_paths.iter() {
            pending_uploads.push((channel_metadata_path.to_string(), &release_metadata));
        }
        for ref channel_update_manifest_path in self.channel_update_manifest_paths.iter() {
            pending_uploads.push((channel_update_manifest_path.to_string(), &update_manifest));
        }
        for (path, metadata) in pending_uploads.drain(..) {
            let path = path.clone();
            let bytes = ByteStream::from(metadata.to_vec());
            let client = client.clone();
            log::info!("upload started, path={}", &path);
            upload_futures.push(tokio::spawn(async move {
                client
                    .put_object()
                    .bucket("dashql-get")
                    .key(&path)
                    .body(bytes)
                    .content_type("application/json")
                    .send()
                    .await
                    .map_err(|e| (path.clone(), e))
                    .map(|_| path.clone())
            }));
        }

        // Join all uploads
        while let Some(next) = upload_futures.next().await {
            match next {
                Ok(Ok(path)) => {
                    log::info!("upload finished, path={}", &path);
                }
                Ok(Err((path, e))) => {
                    log::error!("upload failed, path={}, error={}", &path, &e);
                }
                Err(e) => {
                    log::error!("failed to join upload task, error={}", &e);
                }
            }
        }
        Ok(())
    }
}
