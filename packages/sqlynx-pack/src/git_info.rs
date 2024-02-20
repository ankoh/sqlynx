use anyhow::anyhow;
use anyhow::Result;
use git2::Repository;
use lazy_static::lazy_static;
use regex::Regex;
use semver::BuildMetadata;
use semver::Prerelease;
use semver::Version;
use std::fmt;
use std::path::PathBuf;

lazy_static! {
    static ref REGEX_DESCRIBE_LONG: Regex =
        Regex::new("v([0-9]+).([0-9]+).([0-9]+)-([0-9]+)-g([a-f0-9]+)").unwrap();
}

pub struct GitVersion {
    pub description: String,
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub iteration: u32,
    pub short_hash: String,
}

impl GitVersion {
    pub fn as_semver(&self) -> Version {
        if self.iteration == 0 {
            Version {
                major: self.major as u64,
                minor: self.minor as u64,
                patch: self.patch as u64,
                pre: Prerelease::EMPTY,
                build: BuildMetadata::EMPTY,
            }
        } else {
            Version {
                major: self.major as u64,
                minor: self.minor as u64,
                patch: (self.patch + 1) as u64,
                pre: Prerelease::new(&format!("dev.{}", self.iteration)).unwrap(),
                // build: BuildMetadata::new(&self.short_hash).unwrap(),
                build: BuildMetadata::EMPTY,
            }
        }
    }
}

impl fmt::Display for GitVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.as_semver().fmt(f)
    }
}

pub struct GitInfo {
    pub version: GitVersion,
}

pub fn describe_git_version(source_dir: &PathBuf) -> Result<GitVersion> {
    // Open the current git repository
    let repo = match Repository::open(source_dir) {
        Ok(repo) => repo,
        Err(e) => return Err(anyhow!("failed to open git repository at: {}", e)),
    };
    // Resolve the git repo description
    let mut describe_opts = git2::DescribeOptions::new();
    describe_opts.describe_tags();
    let mut format_opts = git2::DescribeFormatOptions::new();
    format_opts.always_use_long_format(true);

    let description = repo.describe(&describe_opts)?;
    let description_text = description.format(Some(&format_opts))?;

    let description_parts = match REGEX_DESCRIBE_LONG.captures(&description_text) {
        Some(parts) => parts,
        None => {
            return Err(anyhow!(
                "git describe output is not matching version regex: {}",
                &description_text
            ))
        }
    };

    Ok(GitVersion {
        description: description_text.clone(),
        major: description_parts[1].parse().map_err(|e| {
            anyhow!(
                "failed to parse major version {}, {}",
                &description_parts[1],
                e
            )
        })?,
        minor: description_parts[2].parse().map_err(|e| {
            anyhow!(
                "failed to parse minor version {}, {}",
                &description_parts[2],
                e
            )
        })?,
        patch: description_parts[3].parse().map_err(|e| {
            anyhow!(
                "failed to parse patch version {}, {}",
                &description_parts[3],
                e
            )
        })?,
        iteration: description_parts[4].parse().map_err(|e| {
            anyhow!(
                "failed to parse iteration version {}, {}",
                &description_parts[4],
                e
            )
        })?,
        short_hash: description_parts[5].to_string(),
    })
}

pub fn collect_git_info(source_dir: &PathBuf) -> Result<GitInfo> {
    let version = describe_git_version(&source_dir)?;
    Ok(GitInfo { version })
}
