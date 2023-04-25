export * as proto from './gen/flatsql/proto';

interface FlatSQLModuleExports {
    flatsql_malloc: (lenght: number) => number;
    flatsql_free: (ptr: number) => void;
    flatsql_result_delete: (ptr: number) => void;
    flatsql_rope_new: () => number;
    flatsql_rope_delete: (ptr: number) => void;
    flatsql_rope_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    flatsql_rope_insert_char_at: (ptr: number, offset: number, character: number) => void;
    flatsql_rope_erase_text_range: (ptr: number, offset: number, length: number) => void;
    flatsql_rope_to_string: (ptr: number) => number;
    flatsql_parse_rope: (ptr: number) => number;
}

export class FlatSQL {
    encoder: TextEncoder;
    decoder: TextDecoder;
    instance: WebAssembly.Instance;
    instanceExports: FlatSQLModuleExports;
    memory: WebAssembly.Memory;

    public constructor(instance: WebAssembly.Instance) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.instance = instance;
        const parserExports = instance.exports;
        const parserMemory = parserExports['memory'] as unknown as WebAssembly.Memory;
        this.memory = parserMemory;
        this.instanceExports = {
            flatsql_malloc: parserExports['flatsql_malloc'] as (length: number) => number,
            flatsql_free: parserExports['flatsql_free'] as (ptr: number) => void,
            flatsql_result_delete: parserExports['flatsql_result_delete'] as (ptr: number) => void,
            flatsql_rope_new: parserExports['flatsql_rope_new'] as () => number,
            flatsql_rope_delete: parserExports['flatsql_rope_delete'] as (ptr: number) => void,
            flatsql_rope_insert_text_at: parserExports['flatsql_rope_insert_text_at'] as (
                ptr: number,
                offset: number,
                textPtr: number,
                textLength: number,
            ) => void,
            flatsql_rope_insert_char_at: parserExports['flatsql_rope_insert_char_at'] as (
                ptr: number,
                offset: number,
                character: number,
            ) => void,
            flatsql_rope_erase_text_range: parserExports['flatsql_rope_erase_text_range'] as (
                ptr: number,
                offset: number,
                length: number,
            ) => void,
            flatsql_rope_to_string: parserExports['flatsql_rope_to_string'] as (ptr: number) => number,
            flatsql_parse_rope: parserExports['flatsql_parse_rope'] as (ptr: number) => number,
        };
    }

    public static async instantiateStreaming(response: PromiseLike<Response>): Promise<FlatSQL> {
        const instanceRef: { instance: FlatSQL | null } = { instance: null };
        const importStubs = {
            wasi_snapshot_preview1: {
                proc_exit: (code: number) => console.error(`proc_exit(${code})`),
                environ_sizes_get: () => console.error(`environ_sizes_get()`),
                environ_get: (environ: number, buf: number) => console.error(`environ_get(${environ}, ${buf})`),
                fd_fdstat_get: (fd: number) => console.error(`fd_fdstat_get(${fd})`),
                fd_seek: (fd: number, offset: number, whence: number) =>
                    console.error(`fd_seek(${fd}, ${offset}, ${whence})`),
                fd_write: (fd: number, iovs: number) => console.error(`fd_write(${fd}, ${iovs})`),
                fd_read: (fd: number, iovs: number) => console.error(`fd_read(${fd}, ${iovs})`),
                fd_close: (fd: number) => console.error(`fd_close(${fd})`),
            },
            env: {
                log: (text: number, textLength: number) => {
                    const instance = instanceRef.instance!;
                    const textBuffer = new Uint8Array(instance.memory.buffer.slice(text, text + textLength));
                    console.log(instance.decoder.decode(textBuffer));
                },
            },
        };
        const streaming = await WebAssembly.instantiateStreaming(response, importStubs);
        const instance = streaming.instance;
        const startFn = instance.exports['_start'] as () => number;
        startFn();
        instanceRef.instance = new FlatSQL(instance);
        return instanceRef.instance;
    }

    public createRope(): FlatSQLRope {
        const ropePtr = this.instanceExports.flatsql_rope_new();
        return new FlatSQLRope(this, ropePtr);
    }

    public readResult(resultPtr: number) {
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        const dataLength = heapU32[resultPtrU32 + 1];
        const dataPtr = heapU32[resultPtrU32 + 2];
        const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
        if (statusCode == 0) {
            return new FlatSQLBuffer(this, resultPtr, dataArray);
        } else {
            const error = this.decoder.decode(dataArray);
            this.instanceExports.flatsql_result_delete(resultPtr);
            throw new Error(error);
        }
    }

    public parseRope(rope: FlatSQLRope): FlatSQLBuffer {
        const result = this.instanceExports.flatsql_parse_rope(rope.ropePtr);
        return this.readResult(result);
    }
}

export class FlatSQLBuffer {
    /// The FlatSQL api
    api: FlatSQL;
    /// The buffer pointer
    bufferPtr: number | null;
    /// The data view
    dataView: Uint8Array;

    public constructor(api: FlatSQL, resultPtr: number, data: Uint8Array) {
        this.api = api;
        this.bufferPtr = resultPtr;
        this.dataView = data;
    }
    /// Delete the buffer
    public delete() {
        if (this.bufferPtr) {
            this.api.instanceExports.flatsql_result_delete(this.bufferPtr);
        }
        this.bufferPtr = null;
    }
    /// Copy the data into a buffer
    public getDataCopy(): Uint8Array {
        const copy = new Uint8Array(new ArrayBuffer(this.dataView.byteLength));
        copy.set(this.dataView);
        return copy;
    }
    /// Get the data
    public getData(): Uint8Array {
        return this.dataView;
    }
}

export class FlatSQLRope {
    /// The FlatSQL api
    api: FlatSQL;
    /// The rope pointer
    ropePtr: number | null;

    public constructor(api: FlatSQL, ropePtr: number) {
        this.api = api;
        this.ropePtr = ropePtr;
    }
    /// Delete a rope
    public delete() {
        if (this.ropePtr) {
            this.api.instanceExports.flatsql_rope_delete(this.ropePtr);
        }
        this.ropePtr = null;
    }
    /// Insert text at an offset
    public insertTextAt(offset: number, text: string) {
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const textBegin = this.api.instanceExports.flatsql_malloc(text.length * 3);
        const textBuffer = new Uint8Array(this.api.memory.buffer).subarray(textBegin, textBegin + text.length * 3);
        const textEncoded = this.api.encoder.encodeInto(text, textBuffer);
        // Insert into rope
        this.api.instanceExports.flatsql_rope_insert_text_at(this.ropePtr, offset, textBegin, textEncoded.written);
        // Delete text buffer
        this.api.instanceExports.flatsql_free(textBegin);
    }
    /// Insert text at an offset
    public insertCharacterAt(offset: number, utf8Char: number) {
        // Insert character into rope
        this.api.instanceExports.flatsql_rope_insert_char_at(this.ropePtr, offset, utf8Char);
    }
    /// Earse a range of characters
    public eraseTextRange(offset: number, length: number) {
        // Insert into rope
        this.api.instanceExports.flatsql_rope_erase_text_range(this.ropePtr, offset, length);
    }
    /// Convert a rope to a string
    public toString(): string {
        const result = this.api.instanceExports.flatsql_rope_to_string(this.ropePtr);
        const resultBuffer = this.api.readResult(result);
        const text = this.api.decoder.decode(resultBuffer.getData());
        resultBuffer.delete();
        return text;
    }
}
