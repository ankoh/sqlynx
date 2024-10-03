use std::sync::Arc;

use arrow::array::RecordBatch;
use arrow::datatypes::Schema;
use arrow::ipc::reader::StreamDecoder;
use arrow::buffer::Buffer;
use wasm_bindgen::prelude::*;

use crate::data_frame::DataFrame;

#[wasm_bindgen]
pub struct ArrowIngest {
    /// The input stream
    input_stream: StreamDecoder,
    /// The record batches
    batches: Vec<RecordBatch>,
}

#[wasm_bindgen]
impl ArrowIngest {
    /// Construct a data frame
    #[wasm_bindgen(constructor)]
    pub fn new() -> ArrowIngest {
        ArrowIngest {
            input_stream: StreamDecoder::new(),
            batches: Vec::new(),
        }
    }

    /// Read from arrow ipc stream
    pub fn read(&mut self, buffer: &[u8]) -> Result<(), JsError> {
        // Read from the input ipc stream and store record batch, if there is any
        let mut buf = Buffer::from_slice_ref(buffer);
        if let Some(batch) = self.input_stream.decode(&mut buf)? {
            self.batches.push(batch);
        }
        Ok(())
    }

    /// Finish reading from the arrow ipc stream
    pub fn finish(self) -> Result<DataFrame, JsError> {
        // Construct a mem table
        let schema: Arc<Schema>;
        if self.batches.len() == 0 {
            schema = Arc::new(Schema::empty());
        } else {
            schema = self.batches[0].schema().clone();
        }

        // Create a new data frame
        let data_frame = DataFrame::new(schema.clone(), self.batches);
        Ok(data_frame)
    }
}
