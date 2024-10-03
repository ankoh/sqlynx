import * as arrow from 'apache-arrow';
import * as sqlynx_compute from "@ankoh/sqlynx-compute";

// XXX Exceptions

export function dataFrameFromTable(t: arrow.Table): sqlynx_compute.DataFrame {
    const ingest = new sqlynx_compute.ArrowIngest();
    const tableBuffer = arrow.tableToIPC(t, 'stream');
    ingest.read(tableBuffer);
    const dataFrame = ingest.finish();
    ingest.free();
    return dataFrame;
}

export function readDataFrame<T extends arrow.TypeMap = any>(frame: sqlynx_compute.DataFrame): arrow.Table<T> {
    const ipcStream = frame.createIpcStream();
    const ipcStreamIterable = new DataFrameIpcStreamIterable(frame, ipcStream);
    const batchReader = arrow.RecordBatchReader.from(ipcStreamIterable);
    const table = new arrow.Table<T>(batchReader);
    ipcStream.free();
    return table;
}

export class DataFrameIpcStreamIterable implements Iterable<Uint8Array> {
    frame: sqlynx_compute.DataFrame;
    stream: sqlynx_compute.DataFrameIpcStream;

    constructor(frame: sqlynx_compute.DataFrame, stream: sqlynx_compute.DataFrameIpcStream) {
        this.frame = frame;
        this.stream = stream;
    }

    [Symbol.iterator]() {
        return new DataFrameIpcStreamIterator(this.frame, this.stream);
    }
}

export class DataFrameIpcStreamIterator implements Iterator<Uint8Array> {
    frame: sqlynx_compute.DataFrame;
    stream: sqlynx_compute.DataFrameIpcStream;

    constructor(frame: sqlynx_compute.DataFrame, stream: sqlynx_compute.DataFrameIpcStream) {
        this.frame = frame;
        this.stream = stream;
    }

    public next(): IteratorResult<Uint8Array> {
        const result = this.stream.next(this.frame);
        if (result == undefined) {
            return {
                done: true,
                value: null
            };
        } else {
            return {
                done: false,
                value: result
            }
        }
    }
}
