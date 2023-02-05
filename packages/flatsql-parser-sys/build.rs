extern crate cmake;

use std::env;

fn main() {
    // Native build flags
    let target_os = env::var("CARGO_CFG_TARGET_OS");
    match target_os.as_ref().map(|x| &**x) {
        Ok("macos") => {
            println!("cargo:rustc-flags=-l dylib=c++");
        }
        _ => {
            println!("cargo:rustc-flags=-l dylib=stdc++");
        }
    }

    // Check if native library exist
    let build_dir = env::current_dir()
        .unwrap()
        .join("../flatsql-parser/build/native");
    let profile = std::env::var("PROFILE").unwrap();
    let build_dir = match profile.as_str() {
        "debug" => build_dir.join("Debug"),
        _ => build_dir.join("Release"),
    };
    if build_dir.join("libflatsql_parser.a").exists() {
        println!("cargo:rustc-link-search=native={}", build_dir.display());
        return;
    }

    // Build the cmake file
    let dst = cmake::Config::new("../flatsql-parser")
        .build_target("flatsql_parser")
        .always_configure(true)
        .build();
    println!("cargo:rustc-link-search=native={}/build", dst.display());
}
