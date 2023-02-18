#![allow(dead_code)]

use glob::glob;
use log::info;
use clap::Parser;
use quick_xml::Writer;
use quick_xml::events::{Event, BytesStart, BytesEnd, BytesText};
use std::error::Error;
use std::fs;
use std::io::{BufWriter, Write};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(long)]
    glob: String,
    #[arg(long)]
    out: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    env_logger::init_from_env(
        env_logger::Env::default().filter_or(env_logger::DEFAULT_FILTER_ENV, "info"),
    );
    let args = Args::parse();

    info!("glob={}", &args.glob);
    info!("out={}", &args.out);

    let output_file = fs::File::create(args.out)?;
    let mut output_writer = BufWriter::new(output_file);
    let mut xml_writer = Writer::new_with_indent(&mut output_writer, b' ', 4);

    xml_writer.write_event(Event::Start(BytesStart::borrowed_name(b"astdumps")))?;
    for e in glob(&args.glob).expect("Failed to read glob pattern") {
        let path = e.unwrap();
        let filename = path.file_name().unwrap().to_string_lossy();
        let filename = filename.to_string().replace(".", "_");
        info!("{}", filename);
        let content = fs::read_to_string(&path).unwrap();

        let mut dump = BytesStart::borrowed_name(b"astdump");
        dump.push_attribute(("name", filename.as_str()));
        xml_writer.write_event(Event::Start(dump))?;
        xml_writer.write_event(Event::Start(BytesStart::borrowed_name(b"input")))?;
        xml_writer.write_event(Event::Text(BytesText::from_plain_str(&content)))?;
        xml_writer.write_event(Event::End(BytesEnd::borrowed(b"input")))?;
        xml_writer.write_event(Event::End(BytesEnd::borrowed(b"astdump")))?;
    }    
    xml_writer.write_event(Event::End(BytesEnd::borrowed(b"astdumps")))?;

    output_writer.flush().unwrap();
    Ok(())
}