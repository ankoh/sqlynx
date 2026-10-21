use super::release_version::{ReleaseChannel, ReleaseVersion};

/// The object keys a release is uploaded to
pub struct RemotePaths {
    /// The channel metadata keys to point to the release, e.g. `stable.json`
    pub channel_metadata: Vec<&'static str>,
    /// The channel update manifest keys to point to the release, e.g. `stable-update.json`
    pub channel_update: Vec<&'static str>,
    /// The versioned directory of the release, `releases/<version>`
    pub release_directory: String,
    /// The key of the release metadata
    pub release_metadata: String,
    /// The key of the release update manifest
    pub release_update: String,
    /// The name of the release channel, `stable` or `canary`
    pub channel: &'static str,
}

pub fn derive_remote_paths(release: &ReleaseVersion) -> RemotePaths {
    let channel_metadata = match release.channel {
        ReleaseChannel::Stable => vec!["stable.json", "canary.json"],
        ReleaseChannel::Canary => vec!["canary.json"],
    };
    let channel = match release.channel {
        ReleaseChannel::Stable => "stable",
        ReleaseChannel::Canary => "canary",
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
        channel,
    }
}

pub fn electron_channel_manifest(channel: &str, arch: &str) -> String {
    format!("channels/{}/macos/{}/latest-mac.yml", channel, arch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn architecture_specific_electron_feed() {
        assert_eq!(electron_channel_manifest("stable", "arm64"), "channels/stable/macos/arm64/latest-mac.yml");
        assert_eq!(electron_channel_manifest("canary", "x64"), "channels/canary/macos/x64/latest-mac.yml");
    }
}
