use wasm_bindgen::prelude::*;

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/sqlynx.compute.rs"));
}

mod arrow_in;
mod arrow_out;
mod console;
mod data_frame;
#[cfg(test)]
mod data_frame_tests;
#[cfg(test)]
mod datafusion_tests;
mod version;

use console::DEFAULT_LOGGER;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
    log::set_logger(&DEFAULT_LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Info);
}
