use wasm_bindgen::prelude::*;

pub static SQLYNX_VERSION: &str = env!(
    "SQLYNX_VERSION",
    "Can not find find SQLYNX_VERSION in build environment"
);

#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    return SQLYNX_VERSION.to_string();
}
