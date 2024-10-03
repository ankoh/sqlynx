use std::sync::Arc;

use arrow::{datatypes::Schema, ipc::writer::StreamWriter};
use wasm_bindgen::prelude::*;

use crate::data_frame::DataFrame;

#[wasm_bindgen]
pub struct DataFrameIpcStream {
    stream_writer: StreamWriter<Vec<u8>>,
    flushed_schema: bool,
    current_partition: usize,
    next_batch: usize
}

#[wasm_bindgen]
impl DataFrameIpcStream {
    // Construct a new ipc stream from a data frame
    pub(crate) fn new(schema: Arc<Schema>) -> Result<DataFrameIpcStream, JsError> {
        Ok(DataFrameIpcStream {
            stream_writer: StreamWriter::try_new(Vec::new(), &schema)?,
            flushed_schema: false,
            current_partition: 0,
            next_batch: 0,
        })
    }

    // Iterator over an ipc stream.
    // Returns none at the end of the ipc stream.
    pub fn next(&mut self, frame: &DataFrame) -> Result<Option<Vec<u8>>, JsError> {
        // Flushed the schema message?
        // The schema is written to the buffer when setting up the writer.
        if !self.flushed_schema {
            self.flushed_schema = true;
            self.stream_writer.flush()?;
            // Return the buffer to the user
            let buffer = std::mem::take(self.stream_writer.get_mut());
            return Ok(Some(buffer));
        }
        // Reached end of partition?
        while self.next_batch >= frame.partitions[self.current_partition].len() {
            // Depleted all partitions?
            if (self.current_partition + 1) >= frame.partitions.len() {
                return Ok(None);
            } else {
                // Switch to next partition
                self.current_partition += 1;
                self.next_batch = 0;
            }
        }
        // Advance batch
        let this_batch = self.next_batch;
        self.next_batch += 1;
        // Write the record batch
        self.stream_writer.write(&frame.partitions[self.current_partition][this_batch])?;
        // Flush writes to the buffer
        self.stream_writer.flush()?;

        // Return the buffer to the user
        let buffer = std::mem::take(self.stream_writer.get_mut());
        Ok(Some(buffer))
    }
}


