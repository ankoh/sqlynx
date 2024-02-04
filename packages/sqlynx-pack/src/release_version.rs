use super::git_info::GitVersion;
use anyhow::Result;
use semver::Version;
use std::fmt;
use uuid::Uuid;

pub enum ReleaseChannel {
    Stable,
    Canary,
}

impl fmt::Display for ReleaseChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReleaseChannel::Stable => write!(f, "stable"),
            ReleaseChannel::Canary => write!(f, "canary"),
        }
    }
}

pub struct ReleaseVersion {
    pub version: Version,
    pub id: Uuid,
    pub channel: ReleaseChannel,
}

const RELEASE_ID_NAMESPACE: Uuid = uuid::uuid!("444560d1-4268-44be-8016-b09f95eadbba");

pub fn build_release_version(git_version: &GitVersion) -> Result<ReleaseVersion> {
    let semver = git_version.as_semver();
    let semver_text = semver.to_string();
    let id = Uuid::new_v5(&RELEASE_ID_NAMESPACE, semver_text.as_bytes());
    let channel = if git_version.iteration == 0 {
        ReleaseChannel::Stable
    } else {
        ReleaseChannel::Canary
    };
    Ok(ReleaseVersion {
        version: semver,
        id,
        channel,
    })
}
