import * as arrow from 'apache-arrow';
import * as compute from "@ankoh/sqlynx-compute";

export function dataFrameFromTable(t: arrow.Table): compute.DataFrame {
    const ingest = new compute.ArrowIngest();
    const tableBuffer = arrow.tableToIPC(t, 'stream');
    ingest.read(tableBuffer);
    const dataFrame = ingest.finish();
    ingest.free();
    return dataFrame;
}

export function readDataFrame<T extends arrow.TypeMap = any>(frame: compute.DataFrame): arrow.Table<T> {
    const ipcStream = frame.createIpcStream();
    const ipcStreamIterable = new DataFrameIpcStreamIterable(frame, ipcStream);
    const batchReader = arrow.RecordBatchReader.from(ipcStreamIterable);
    const table = new arrow.Table<T>(batchReader);
    ipcStream.free();
    return table;
}

export class DataFrameIpcStreamIterable implements Iterable<Uint8Array> {
    frame: compute.DataFrame;
    stream: compute.DataFrameIpcStream;

    constructor(frame: compute.DataFrame, stream: compute.DataFrameIpcStream) {
        this.frame = frame;
        this.stream = stream;
    }

    [Symbol.iterator]() {
        return new DataFrameIpcStreamIterator(this.frame, this.stream);
    }
}

export class DataFrameIpcStreamIterator implements Iterator<Uint8Array> {
    frame: compute.DataFrame;
    stream: compute.DataFrameIpcStream;

    constructor(frame: compute.DataFrame, stream: compute.DataFrameIpcStream) {
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
