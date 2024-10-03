use wasm_bindgen::prelude::*;

pub static SQLYNX_COMPUTE_GIT_HASH_SHORT: &str = env!(
    "GIT_HASH_SHORT",
    "Can not find find GIT_HASH_SHORT in build environment"
);

#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    return SQLYNX_COMPUTE_GIT_HASH_SHORT.to_string();
}
