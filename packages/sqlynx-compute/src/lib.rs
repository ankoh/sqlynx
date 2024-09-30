use wasm_bindgen::prelude::*;

mod console;
#[cfg(test)]
mod datafusion_tests;

use console::DEFAULT_LOGGER;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
    log::set_logger(&DEFAULT_LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Info);
}
