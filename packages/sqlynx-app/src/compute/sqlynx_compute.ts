import * as sqlynx_compute from "@ankoh/sqlynx-compute";

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
