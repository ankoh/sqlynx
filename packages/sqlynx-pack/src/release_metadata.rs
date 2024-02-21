use std::collections::HashMap;

use crate::serde_date;
use crate::serde_version;
use anyhow::Result;
use chrono::prelude::*;
use semver::Version;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Eq, PartialEq, Hash, Debug)]
pub enum Platform {
    Darwin,
    Linux,
    Windows,
}

#[derive(Eq, PartialEq, Hash, Debug)]
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

#[derive(Hash, Eq, PartialEq, Debug)]
pub struct BundleTarget {
    pub platform: Platform,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateArtifact {
    pub url: String,
    pub signature: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateManifest {
    #[serde(with = "serde_version")]
    pub version: Version,
    pub notes: String,
    #[serde(with = "serde_date")]
    pub pub_date: DateTime<Utc>,
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

#[derive(Serialize, Deserialize, Debug)]
pub struct Bundle {
    pub url: String,
    pub signature: Option<String>,
    pub name: String,
    pub bundle_type: BundleType,
    pub targets: Vec<BundleTarget>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReleaseMetadata {
    pub release_id: String,
    #[serde(with = "serde_date")]
    pub pub_date: DateTime<Utc>,
    #[serde(with = "serde_version")]
    pub version: Version,
    pub bundles: Vec<Bundle>,
    pub update_manifest: String,
}

impl Default for ReleaseMetadata {
    fn default() -> Self {
        Self {
            release_id: String::default(),
            pub_date: DateTime::default(),
            version: Version::new(0, 0, 0),
            bundles: Vec::default(),
            update_manifest: String::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::RemoteRelease as TauriRemoteRelease;

    #[test]
    fn test_tauri_manifest() -> Result<()> {
        // Make sure we can read a tauri update manifest correctly
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

        // Make sure the test config is still a valid tauri config
        let tauri_release: TauriRemoteRelease = serde_json::from_str(data)?;
        assert_eq!(tauri_release.version.major, 1);
        Ok(())
    }
}
