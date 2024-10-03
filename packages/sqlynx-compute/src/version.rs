use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    return "foo".to_string();
}
