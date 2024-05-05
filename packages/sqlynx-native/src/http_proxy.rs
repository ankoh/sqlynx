use std::sync::Arc;

use crate::http_stream_manager::HttpStreamManager;


pub struct HttpProxy {
    pub streams: Arc<HttpStreamManager>,
}

impl Default for HttpProxy {
    fn default() -> Self {
        Self {
            streams: Default::default(),
        }
    }
}

