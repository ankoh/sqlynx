use core::fmt;
use prost_build::Config;
use regex::Regex;

#[derive(Default)]
struct SemVer {
    major: u32,
    minor: u32,
    patch: u32,
    dev: u32,
    commit: String,
}

impl fmt::Display for SemVer {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        if self.dev == 0 {
            write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
        } else {
            write!(f, "{}.{}.{}-dev.{}", self.major, self.minor, self.patch, self.dev)
        }
    }
}

fn resolve_git_semver() -> anyhow::Result<SemVer> {
    let raw_git_commit_hash = std::process::Command::new("git")
        .args(&["log", "-1", "--format=%h"])
        .output()?
        .stdout;
    let raw_git_last_tag = std::process::Command::new("git")
        .args(&["describe", "--tags", "--abbrev=0"])
        .output()?
        .stdout;
    let raw_git_iteration = std::process::Command::new("git")
        .args(&["describe", "--tags", "--long"])
        .output()?
        .stdout;
    let git_commit = std::str::from_utf8(&raw_git_commit_hash)?
        .trim()
        .to_string();
    let git_last_tag = std::str::from_utf8(&raw_git_last_tag)?
        .trim()
        .to_string();
    let git_iteration = std::str::from_utf8(&raw_git_iteration)?
        .trim()
        .to_string();

    let mut out = SemVer::default();

    let parsed_last_tag = match Regex::new("v([0-9]+).([0-9]+).([0-9]+)")?.captures(&git_last_tag) {
        Some(v) => v,
        None => anyhow::bail!("failed to parse git commit hash"),
    };
    out.major = parsed_last_tag.get(1).unwrap().as_str().parse()?;
    out.minor = parsed_last_tag.get(2).unwrap().as_str().parse()?;
    out.patch = parsed_last_tag.get(3).unwrap().as_str().parse()?;

    let parsed_iteration = match Regex::new(".*-([0-9]+)-.*")?.captures(&git_iteration) {
        Some(v) => v,
        None => anyhow::bail!("failed to parse git iteration"),
    };
    out.dev = parsed_iteration.get(1).unwrap().as_str().parse()?;

    out.commit = git_commit;
    Ok(out)
}

fn main() -> anyhow::Result<()> {
    let semver = resolve_git_semver()?;

    println!("cargo:rerun-if-env-changed=SQLYNX_VERSION");
    println!("cargo:rustc-env=SQLYNX_VERSION_MAJOR={}", semver.major);
    println!("cargo:rustc-env=SQLYNX_VERSION_MINOR={}", semver.minor);
    println!("cargo:rustc-env=SQLYNX_VERSION_PATCH={}", semver.patch);
    println!("cargo:rustc-env=SQLYNX_VERSION_DEV={}", semver.dev);
    println!("cargo:rustc-env=SQLYNX_VERSION_COMMIT={}", semver.commit);
    println!("cargo:rustc-env=SQLYNX_VERSION_TEXT={}", semver);

    println!("cargo:rerun-if-changed=../../proto/pb/sqlynx/compute/compute.proto");
    Config::new()
        .out_dir("src/proto/")
        .compile_protos(
            &[
                "../../proto/pb/sqlynx/compute/compute.proto",
            ],
            &["../../proto/pb/"])?;
    Ok(())
}
