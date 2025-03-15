use super::release_version::{ReleaseChannel, ReleaseVersion};

pub struct RemotePaths {
    pub channel_metadata: Vec<&'static str>,
    pub channel_update: Vec<&'static str>,
    pub release_directory: String,
    pub release_metadata: String,
    pub release_update: String,
}

pub fn derive_remote_paths(release: &ReleaseVersion) -> RemotePaths {
    let channel_metadata = match release.channel {
        ReleaseChannel::Stable => vec!["stable.json", "canary.json"],
        ReleaseChannel::Canary => vec!["canary.json"],
    };
    let channel_update = match release.channel {
        ReleaseChannel::Stable => vec!["stable-update.json", "canary-update.json"],
        ReleaseChannel::Canary => vec!["canary-update.json"],
    };
    let release_directory = format!("releases/{}", release.version.to_string());
    let release_metadata = format!("{}/{}", &release_directory, "metadata.json");
    let release_update = format!("{}/{}", &release_directory, "update.json");
    RemotePaths {
        channel_metadata,
        channel_update,
        release_directory,
        release_metadata,
        release_update,
    }
}
