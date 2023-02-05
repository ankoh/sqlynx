#![allow(dead_code)]

use clap::Parser;
use flatsql_parser::parse_into;
use flatsql_tools::grammar::ast_dump::ASTDump;
use flatsql_tools::grammar::ast_dump::ASTDumpTemplateFile;
use flatsql_tools::*;
use log::info;
use quick_xml::Writer;
use std::error::Error;
use std::fs;
use std::io::BufReader;
use std::io::BufWriter;
use std::io::Write;
use std::path::PathBuf;

use grammar::ast_dump::ASTDumpFile;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(long)]
    dir: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    env_logger::init_from_env(
        env_logger::Env::default().filter_or(env_logger::DEFAULT_FILTER_ENV, "info"),
    );
    let args = Args::parse();

    let dir_path = PathBuf::from(&args.dir).canonicalize()?;
    info!("directory={}", &args.dir);

    let paths = fs::read_dir(&dir_path).unwrap();
    for file_path in paths {
        let file_path = file_path?;
        let file_name_os = file_path.file_name();
        let file_name_str = file_name_os.to_str().unwrap_or_default();
        let tpl_suffix = ".tpl.xml";
        if !file_name_str.ends_with(tpl_suffix) {
            continue;
        }
        info!("dump_file={}", &file_name_str);
        let prefix = file_name_str.strip_suffix(tpl_suffix).unwrap_or_default();

        let input_file = fs::File::open(&file_path.path())?;
        let input_reader = BufReader::new(input_file);
        let dump_file: ASTDumpTemplateFile = quick_xml::de::from_reader(input_reader)?;

        let mut dumps = Vec::new();
        let alloc = bumpalo::Bump::new();
        for dump in dump_file.dumps.iter() {
            let (ast, _ast_data) = parse_into(&alloc, &dump.input)?;
            dumps.push(ASTDump {
                name: dump.name.clone(),
                input: &dump.input,
                parsed: Some(ast),
            });
        }
        let output_dump = ASTDumpFile { dumps };

        let output_file = fs::File::create(&dir_path.join(format!("{}.xml", prefix)))?;
        let mut output_writer = BufWriter::new(output_file);
        let mut xml_writer = Writer::new_with_indent(&mut output_writer, b' ', 4);
        output_dump.write_xml(&mut xml_writer)?;
        output_writer.flush()?;
    }
    Ok(())
}
