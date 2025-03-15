use wasm_bindgen::prelude::*;

pub static DASHQL_VERSION_MAJOR: &str = env!(
    "DASHQL_VERSION_MAJOR",
    "Can not find find DASHQL_VERSION_MAJOR in build environment"
);
pub static DASHQL_VERSION_MINOR: &str = env!(
    "DASHQL_VERSION_MINOR",
    "Can not find find DASHQL_VERSION_MINOR in build environment"
);
pub static DASHQL_VERSION_PATCH: &str = env!(
    "DASHQL_VERSION_PATCH",
    "Can not find find DASHQL_VERSION_PATCH in build environment"
);
pub static DASHQL_VERSION_DEV: &str = env!(
    "DASHQL_VERSION_DEV",
    "Can not find find DASHQL_VERSION_DEV in build environment"
);
pub static DASHQL_VERSION_COMMIT: &str = env!(
    "DASHQL_VERSION_COMMIT",
    "Can not find find DASHQL_VERSION_COMMIT in build environment"
);
pub static DASHQL_VERSION_TEXT: &str = env!(
    "DASHQL_VERSION_TEXT",
    "Can not find find DASHQL_VERSION_TEXT in build environment"
);


#[wasm_bindgen]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub dev: u32,
    #[wasm_bindgen(skip)]
    pub text: String,
    #[wasm_bindgen(skip)]
    pub commit: String,
}

#[wasm_bindgen]
impl Version {
    #[wasm_bindgen(getter = text)]
    pub fn get_text(&self) -> String {
        self.text.clone()
    }
    #[wasm_bindgen(getter = commit)]
    pub fn get_commit(&self) -> String {
        self.commit.clone()
    }
}


#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> Version {
    Version {
        major: DASHQL_VERSION_MAJOR.parse().unwrap_or_default(),
        minor: DASHQL_VERSION_MINOR.parse().unwrap_or_default(),
        patch: DASHQL_VERSION_PATCH.parse().unwrap_or_default(),
        dev: DASHQL_VERSION_DEV.parse().unwrap_or_default(),
        text: DASHQL_VERSION_TEXT.to_string().into(),
        commit: DASHQL_VERSION_COMMIT.to_string().into(),
    }
}
