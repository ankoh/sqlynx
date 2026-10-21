//! dashql-cli: checks DashQL scripts with the native dashql-core

mod inputs;
mod lint;
mod report;

use lint::{Linter, Severity};
use report::{format_file, format_summary, format_timings, Style};
use std::io::Write;
use std::process::ExitCode;
use std::time::Instant;

const USAGE: &str = "dashql-cli: check DashQL scripts

Usage:
  dashql-cli lint [options] <file.sql|dir|->...
      Scans, parses and analyzes the scripts with dashql-core and prints the scripts with diagnostics.
      --schema <file.sql>      Schema script (CREATE TABLE ...) to resolve names against, can be repeated
      --debug                  Show where the time goes

Directories are searched recursively for *.sql files, - reads a script from stdin.
Exits with 0 without errors (warnings are fine), 1 with errors and 2 on usage or I/O errors.";

/// The arguments of `lint`
#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    /// The schema scripts passed with `--schema`
    schemas: Vec<String>,
    /// The files, directories or `-` to lint
    paths: Vec<String>,
    /// Print timings with `--debug`
    debug: bool,
    /// Print the usage with `-h` or `--help`
    help: bool,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = Args::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--schema" => out.schemas.push(args.next().ok_or("option --schema needs a file")?.clone()),
            "--debug" => out.debug = true,
            "-h" | "--help" => out.help = true,
            "--" => out.paths.extend(args.by_ref().cloned()),
            a if a.starts_with("--schema=") => out.schemas.push(a["--schema=".len()..].to_string()),
            a if a.starts_with('-') && a != inputs::STDIN => return Err(format!("unknown option {a}")),
            a => out.paths.push(a.to_string()),
        }
    }
    Ok(out)
}

fn lint(args: Args) -> Result<ExitCode, String> {
    let style = Style::for_stdout();
    let schemas = inputs::read_inputs(&args.schemas)?;
    let inputs = inputs::read_inputs(&args.paths)?;
    let mut stdout = std::io::stdout().lock();
    let mut write = |text: String| writeln!(stdout, "{text}").map_err(|e| format!("stdout: {e}"));

    let start = Instant::now();
    let mut linter = Linter::new();
    // Schemas come first, so that the scripts find their tables
    let schema_diagnostics = schemas.iter().map(|schema| linter.add_schema(schema)).collect::<Vec<_>>();
    let diagnostics = schema_diagnostics.into_iter().chain(inputs.iter().map(|input| linter.lint(input)));
    let (mut errors, mut warnings) = (0, 0);
    for (input, diagnostics) in schemas.iter().chain(&inputs).zip(diagnostics.collect::<Vec<_>>()) {
        if diagnostics.is_empty() {
            continue;
        }
        for d in &diagnostics {
            match d.severity {
                Severity::Error => errors += 1,
                Severity::Warning => warnings += 1,
            }
        }
        write(format!("{}\n", format_file(&input.id, &input.text, &diagnostics, style)))?;
    }
    if args.debug {
        write(format!("{}\n", format_timings(start.elapsed(), style)))?;
    }
    write(format_summary(schemas.len() + inputs.len(), errors, warnings, style))?;
    // Warnings alone do not fail
    Ok(ExitCode::from(if errors > 0 { 1 } else { 0 }))
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (command, args) = argv.split_first().map_or((None, &[][..]), |(c, a)| (Some(c.as_str()), a));
    match command {
        Some("lint") => {}
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some(command) => {
            eprintln!("error: unknown command {command}\n\n{USAGE}");
            return ExitCode::from(2);
        }
        None => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    }
    let args = match parse_args(args) {
        Ok(args) if args.help => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(args) if args.paths.is_empty() => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
        Ok(args) => args,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    lint(args).unwrap_or_else(|e| {
        eprintln!("error: {e}");
        ExitCode::from(2)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_options_and_paths() {
        assert_eq!(
            parse(&["--schema", "s.sql", "a.sql", "--schema=t.sql", "-", "--debug", "--", "--odd.sql"]),
            Ok(Args {
                schemas: vec!["s.sql".into(), "t.sql".into()],
                paths: vec!["a.sql".into(), "-".into(), "--odd.sql".into()],
                debug: true,
                help: false,
            })
        );
        assert_eq!(parse(&["--schema"]), Err("option --schema needs a file".into()));
        assert_eq!(parse(&["--bogus"]), Err("unknown option --bogus".into()));
    }
}
