use wasm_bindgen::prelude::*;

mod arrow_ingest;
mod console;
mod data_frame;
mod data_frame_ipc;
#[cfg(test)]
mod data_frame_tests;
#[cfg(test)]
mod fusion_tests;
mod version;

use console::DEFAULT_LOGGER;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
    log::set_logger(&DEFAULT_LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Info);
}
