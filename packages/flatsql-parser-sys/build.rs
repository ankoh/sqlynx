extern crate cmake;

use std::env;

fn main() {
    let dst = cmake::Config::new("../flatsql-parser")
        .build_target("flatsql_parser")
        .always_configure(true)
        .build();
    println!("cargo:rustc-link-search=native={}/build", dst.display());
    let target_os = env::var("CARGO_CFG_TARGET_OS");
    match target_os.as_ref().map(|x| &**x) {
        Ok("macos") => {
            println!("cargo:rustc-flags=-l dylib=c++");
        }
        _ => {
            println!("cargo:rustc-flags=-l dylib=stdc++");
        }
    }
}