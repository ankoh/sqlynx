use std::collections::HashMap;

use crate::serde_date;
use crate::serde_version;
use anyhow::Result;
use chrono::prelude::*;
use semver::Version;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
pub enum Platform {
    Darwin,
    Linux,
    Windows,
}

#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
pub enum Architecture {
    X86_64,
    Aarch64,
}

#[derive(Eq, PartialEq, Hash, Serialize, Deserialize, Debug)]
pub enum BundleType {
    Dmg,
    App,
    AppImage,
    Nsis,
}

/// A platform and architecture a bundle runs on, serialized as `<platform>-<arch>`
#[derive(Hash, Eq, PartialEq, Debug)]
pub struct BundleTarget {
    /// The operating system
    pub platform: Platform,
    /// The CPU architecture
    pub arch: Architecture,
}

impl Serialize for BundleTarget {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let arch = match self.arch {
            Architecture::X86_64 => "x86_64",
            Architecture::Aarch64 => "aarch64",
        };
        let platform = match self.platform {
            Platform::Darwin => "darwin",
            Platform::Windows => "windows",
            Platform::Linux => "linux",
        };
        serializer.serialize_str(&format!("{}-{}", platform, arch))
    }
}
impl<'d> Deserialize<'d> for BundleTarget {
    fn deserialize<D>(deserializer: D) -> Result<BundleTarget, D::Error>
    where
        D: Deserializer<'d>,
    {
        let s = String::deserialize(deserializer)?;
        let invalid_value_error = |s: &str| {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(s),
                &"{platform}_arch",
            ))
        };
        let parts: Vec<&str> = s.split("-").collect();
        if parts.len() != 2 {
            return invalid_value_error(&s);
        }
        let platform = match parts[0] {
            "darwin" => Platform::Darwin,
            "linux" => Platform::Linux,
            "windows" => Platform::Windows,
            _ => {
                return Err(serde::de::Error::invalid_value(
                    serde::de::Unexpected::Str(&s),
                    &"darwin",
                ))
            }
        };
        let arch = match parts[1] {
            "x86_64" => Architecture::X86_64,
            "aarch64" => Architecture::Aarch64,
            _ => {
                return Err(serde::de::Error::invalid_value(
                    serde::de::Unexpected::Str(&s),
                    &"x86_64 or aarch64",
                ))
            }
        };
        Ok(BundleTarget { platform, arch })
    }
}

/// An update artifact of a single platform in an [`UpdateManifest`]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateArtifact {
    /// The public URL of the update ZIP
    pub url: String,
    /// The signature of the update artifact, currently empty
    pub signature: String,
}

/// The update manifest of a release, listing the update artifact per platform
#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateManifest {
    /// The release version
    #[serde(with = "serde_version")]
    pub version: Version,
    /// The release notes, currently empty
    pub notes: String,
    /// The publication date
    #[serde(with = "serde_date")]
    pub pub_date: DateTime<Utc>,
    /// The update artifacts, keyed by target platform
    pub platforms: HashMap<BundleTarget, UpdateArtifact>,
}

impl Default for UpdateManifest {
    fn default() -> Self {
        Self {
            version: Version::new(0, 0, 0),
            notes: String::default(),
            pub_date: DateTime::default(),
            platforms: HashMap::default(),
        }
    }
}

/// A downloadable installer bundle of a release
#[derive(Serialize, Deserialize, Debug)]
pub struct Bundle {
    /// The public URL of the bundle
    pub url: String,
    /// The signature of the bundle, if signed
    pub signature: Option<String>,
    /// The file name of the bundle
    pub name: String,
    /// The bundle format
    pub bundle_type: BundleType,
    /// The platforms the bundle runs on
    pub targets: Vec<BundleTarget>,
}

/// The metadata of a release, uploaded next to its artifacts and to the channel pointers
#[derive(Serialize, Deserialize, Debug)]
pub struct ReleaseMetadata {
    /// The release id, a UUID derived from the version
    pub release_id: String,
    /// The publication date
    #[serde(with = "serde_date")]
    pub pub_date: DateTime<Utc>,
    /// The release version
    #[serde(with = "serde_version")]
    pub version: Version,
    /// The abbreviated hash of the released commit
    pub git_commit_hash: String,
    /// The GitHub URL of the released commit
    pub git_commit_url: String,
    /// The public URL of the release update manifest
    pub update_manifest_url: String,
    /// The downloadable bundles of the release
    pub bundles: Vec<Bundle>,
}

/// A summary of a published release, optionally written by the publish command
#[derive(Serialize, Deserialize, Debug)]
pub struct ReleaseSummary {
    /// The release id, a UUID derived from the version
    pub release_id: String,
    /// The release version
    #[serde(with = "serde_version")]
    pub version: Version,
    /// The publication date
    #[serde(with = "serde_date")]
    pub pub_date: DateTime<Utc>,
    /// The abbreviated hash of the released commit
    pub git_commit_hash: String,
    /// The GitHub URL of the released commit
    pub git_commit_url: String,
    /// The public URL of the release metadata
    pub release_metadata_url: String,
    /// The public URL of the release update manifest
    pub update_manifest_url: String,
    /// The public URL of the first macOS DMG bundle
    pub bundle_macos_dmg_url: String,
}

impl Default for ReleaseMetadata {
    fn default() -> Self {
        Self {
            release_id: String::default(),
            pub_date: DateTime::default(),
            version: Version::new(0, 0, 0),
            git_commit_hash: String::default(),
            git_commit_url: String::default(),
            update_manifest_url: String::default(),
            bundles: Vec::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_update_manifest() -> Result<()> {
        let data = r#"
            {
                "version": "1.0.0",
                "notes": "Test version",
                "pub_date": "2020-06-22T19:25:57Z",
                "platforms": {
                    "darwin-x86_64": {
                        "url": "https://github.com/username/reponame/releases/download/v1.0.0/app-x86_64.app.tar.gz",
                        "signature": "Content of app.tar.gz.sig"
                    },
                    "darwin-aarch64": {
                        "url": "https://github.com/username/reponame/releases/download/v1.0.0/app-aarch64.app.tar.gz",
                        "signature": "Content of app.tar.gz.sig"
                    },
                    "linux-x86_64": {
                        "url": "https://github.com/username/reponame/releases/download/v1.0.0/app-amd64.AppImage.tar.gz",
                        "signature": "Content of app.AppImage.tar.gz.sig"
                    },
                    "windows-x86_64": {
                        "url": "https://github.com/username/reponame/releases/download/v1.0.0/app-x64-setup.nsis.zip",
                        "signature": "Content of app-setup.nsis.sig or app.msi.sig, depending on the chosen format"
                    }
                }
            }
        "#;

        // Parse the string of data into serde_json::Value.
        let v: UpdateManifest = serde_json::from_str(data)?;
        assert_eq!(v.version.major, 1);
        assert_eq!(v.version.minor, 0);
        assert_eq!(v.version.patch, 0);
        assert_eq!(v.notes, "Test version");
        assert_eq!(v.platforms.len(), 4);
        assert!(v.platforms.contains_key(&BundleTarget {
            platform: Platform::Darwin,
            arch: Architecture::X86_64,
        }));
        assert!(v.platforms.contains_key(&BundleTarget {
            platform: Platform::Darwin,
            arch: Architecture::Aarch64,
        }));
        assert!(v.platforms.contains_key(&BundleTarget {
            platform: Platform::Linux,
            arch: Architecture::X86_64,
        }));
        assert!(v.platforms.contains_key(&BundleTarget {
            platform: Platform::Windows,
            arch: Architecture::X86_64,
        }));
        let darwin_x64 = &v
            .platforms
            .get(&BundleTarget {
                platform: Platform::Darwin,
                arch: Architecture::X86_64,
            })
            .unwrap();
        assert_eq!(
            darwin_x64.url,
            "https://github.com/username/reponame/releases/download/v1.0.0/app-x86_64.app.tar.gz"
        );
        assert_eq!(darwin_x64.signature, "Content of app.tar.gz.sig");

        Ok(())
    }
}
