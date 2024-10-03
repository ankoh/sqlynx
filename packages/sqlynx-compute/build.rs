use std::process::Command;

fn get_git_hash() -> String {
    let git_hash = {
        let output = Command::new("git")
            .args(["describe", "--always", "--dirty", "--abbrev=64"])
            .output()
            .expect("failed to execute git rev-parse to read the current git hash");

        String::from_utf8(output.stdout).expect("non-utf8 found in git hash")
    };

    assert!(!git_hash.is_empty(), "attempting to embed empty git hash");
    git_hash
}

fn get_git_hash_short() -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .expect("failed to execute git rev-parse to read the current git hash");
    String::from_utf8(output.stdout).expect("non-utf8 found in git hash")
}

fn main() {
    println!("cargo:rerun-if-env-changed=GIT_HASH");
    println!("cargo:rustc-env=GIT_HASH={}", get_git_hash());
    println!("cargo:rustc-env=GIT_HASH_SHORT={}", get_git_hash_short());
}
