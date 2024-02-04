use crate::git_info;
use anyhow::Result;
use clap::Parser;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;
use toml::Value as TomlValue;

#[derive(Parser, Debug)]
pub struct FreezeArgs {}

fn update_package_json(path: &PathBuf, version: &str) -> Result<()> {
    let mut value: serde_json::Value;
    {
        let file = File::open(path)?;
        let reader = BufReader::new(&file);
        value = serde_json::from_reader(reader)?;
        if let JsonValue::Object(o) = &mut value {
            if let Some(v) = o.get_mut("version") {
                *v = JsonValue::String(version.to_string());
            }
        }
    }
    {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
        let mut ser = serde_json::Serializer::with_formatter(&mut writer, formatter);
        value.serialize(&mut ser)?;
        writer.flush()?;
    }
    Ok(())
}

fn update_tauri_config_json(path: &PathBuf, version: &str) -> Result<()> {
    let mut value: serde_json::Value;
    {
        let file = File::open(path)?;
        let reader = BufReader::new(&file);
        value = serde_json::from_reader(reader)?;
        if let JsonValue::Object(o) = &mut value {
            if let Some(v) = o.get_mut("version") {
                *v = JsonValue::String(version.to_string());
            }
        }
    }
    {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
        let mut ser = serde_json::Serializer::with_formatter(&mut writer, formatter);
        value.serialize(&mut ser)?;
        writer.flush()?;
    }
    Ok(())
}

fn update_cargo_toml(path: &PathBuf, version: &str) -> Result<()> {
    let content = std::fs::read_to_string(&path)?;
    let mut value = toml::from_str(&content)?;
    if let TomlValue::Table(o) = &mut value {
        if let Some(TomlValue::Table(pkg)) = o.get_mut("package") {
            if let Some(TomlValue::String(v)) = pkg.get_mut("version") {
                *v = version.to_string();
            }
        }
    }
    let new_content = toml::to_string_pretty(&value)?;
    std::fs::write(&path, new_content)?;
    Ok(())
}

pub fn freeze() -> Result<()> {
    let source_dir = std::env::current_dir()?;
    let app_package_json = source_dir
        .join("packages")
        .join("sqlynx-app")
        .join("package.json");
    let core_api_package_json = source_dir
        .join("packages")
        .join("sqlynx-core-api")
        .join("package.json");
    let hyper_service_package_json = source_dir
        .join("packages")
        .join("hyper-service")
        .join("package.json");
    let tauri_config_json = source_dir
        .join("packages")
        .join("sqlynx-native")
        .join("tauri.conf.json");
    let native_toml = source_dir
        .join("packages")
        .join("sqlynx-native")
        .join("Cargo.toml");
    let pack_toml = source_dir
        .join("packages")
        .join("sqlynx-pack")
        .join("Cargo.toml");

    let git_repo = git_info::collect_git_info(&source_dir)?;
    let version = git_repo.version.as_semver().to_string();

    log::info!("version: {}", &version);
    log::info!("patching @ankoh/sqlynx-app package.json");
    update_package_json(&app_package_json, &version)?;
    log::info!("patching @ankoh/sqlynx-core-api package.json");
    update_package_json(&core_api_package_json, &version)?;
    log::info!("patching @ankoh/hyper-service package.json");
    update_package_json(&hyper_service_package_json, &version)?;
    log::info!("patching @ankoh/sqlynx-native tauri.conf.json");
    update_tauri_config_json(&tauri_config_json, &version)?;
    log::info!("patching sqlynx-native Cargo.toml");
    update_cargo_toml(&native_toml, &version)?;
    log::info!("patching sqlynx-pack Cargo.toml");
    update_cargo_toml(&pack_toml, &version)?;

    Ok(())
}
