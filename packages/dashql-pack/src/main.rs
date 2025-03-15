mod freeze_command;
mod git_info;
mod publish_command;
mod release;
mod release_metadata;
mod release_version;
mod remote_access;
mod remote_paths;
mod serde_date;
mod serde_version;
mod vacuum_command;

use anyhow::Result;
use clap::{Parser, Subcommand};
use freeze_command::{freeze, FreezeArgs};
use publish_command::{publish, PublishArgs};
use std::env;
use vacuum_command::{vacuum, VacuumArgs};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Subcommand, Debug)]
enum CliCommand {
    Version,
    Freeze(FreezeArgs),
    Publish(PublishArgs),
    Vacuum(VacuumArgs),
}

fn print_version() -> Result<()> {
    let source_dir = std::env::current_dir()?;
    let git_repo = git_info::collect_git_info(&source_dir)?;
    println!("{}", &git_repo.version.as_semver());
    Ok(())
}

#[::tokio::main]
async fn main() -> Result<()> {
    // Setup the logger
    if env::var("RUST_LOG").is_err() {
        env::set_var("RUST_LOG", "info")
    }
    env_logger::init();

    // Parse arguments
    let args = Cli::try_parse()?;

    match args.command {
        CliCommand::Version => print_version()?,
        CliCommand::Freeze(_args) => freeze()?,
        CliCommand::Publish(args) => publish(args).await?,
        CliCommand::Vacuum(args) => vacuum(args).await?,
    };
    Ok(())
}
