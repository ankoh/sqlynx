export * as proto from '../gen/flatsql/proto';

interface FlatSQLModuleExports {
    flatsql_malloc: (lenght: number) => number;
    flatsql_free: (ptr: number) => void;
    flatsql_result_delete: (ptr: number) => void;
    flatsql_script_new: () => number;
    flatsql_script_delete: (ptr: number) => void;
    flatsql_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    flatsql_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    flatsql_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    flatsql_script_to_string: (ptr: number) => number;
    flatsql_parse_rope: (ptr: number) => number;
}

type InstantiateWasmCallback = (stubs: WebAssembly.Imports) => PromiseLike<WebAssembly.WebAssemblyInstantiatedSource>;

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
            flatsql_script_new: parserExports['flatsql_script_new'] as () => number,
            flatsql_script_delete: parserExports['flatsql_script_delete'] as (ptr: number) => void,
            flatsql_script_insert_text_at: parserExports['flatsql_script_insert_text_at'] as (
                ptr: number,
                offset: number,
                textPtr: number,
                textLength: number,
            ) => void,
            flatsql_script_insert_char_at: parserExports['flatsql_script_insert_char_at'] as (
                ptr: number,
                offset: number,
                character: number,
            ) => void,
            flatsql_script_erase_text_range: parserExports['flatsql_script_erase_text_range'] as (
                ptr: number,
                offset: number,
                length: number,
            ) => void,
            flatsql_script_to_string: parserExports['flatsql_script_to_string'] as (ptr: number) => number,
            flatsql_parse_rope: parserExports['flatsql_parse_rope'] as (ptr: number) => number,
        };
    }

    public static async create(instantiate: InstantiateWasmCallback): Promise<FlatSQL> {
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
        const streaming = await instantiate(importStubs);
        const instance = streaming.instance;
        const startFn = instance.exports['_start'] as () => number;
        startFn();
        instanceRef.instance = new FlatSQL(instance);
        return instanceRef.instance;
    }

    public createScript(): FlatSQLScript {
        const scriptPtr = this.instanceExports.flatsql_script_new();
        return new FlatSQLScript(this, scriptPtr);
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

export const NULL_POINTER_EXCEPTION = new Error('tried to access a null pointer');

export class FlatSQLScript {
    /// The FlatSQL api
    api: FlatSQL;
    /// The script pointer
    scriptPtr: number | null;

    public constructor(api: FlatSQL, ropePtr: number) {
        this.api = api;
        this.scriptPtr = ropePtr;
    }
    /// Delete a rope
    public delete() {
        if (this.scriptPtr) {
            this.api.instanceExports.flatsql_script_delete(this.scriptPtr);
        }
        this.scriptPtr = null;
    }
    /// Make sure the script is not null
    protected assertScriptNotNull(): number {
        if (this.scriptPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.scriptPtr!;
    }
    /// Insert text at an offset
    public insertTextAt(offset: number, text: string) {
        const scriptPtr = this.assertScriptNotNull();
        // Short-circuit inserting texts of length 1
        if (text.length == 1) {
            this.api.instanceExports.flatsql_script_insert_char_at(scriptPtr, offset, text.charCodeAt(0));
            return;
        }
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const textBegin = this.api.instanceExports.flatsql_malloc(text.length * 3);
        const textBuffer = new Uint8Array(this.api.memory.buffer).subarray(textBegin, textBegin + text.length * 3);
        const textEncoded = this.api.encoder.encodeInto(text, textBuffer);
        // Nothing written?
        if (textEncoded.written == undefined || textEncoded.written == 0) {
            this.api.instanceExports.flatsql_free(textBegin);
            return;
        }
        // Insert into rope
        this.api.instanceExports.flatsql_script_insert_text_at(scriptPtr, offset, textBegin, textEncoded.written);
        // Delete text buffer
        this.api.instanceExports.flatsql_free(textBegin);
    }
    /// Earse a range of characters
    public eraseTextRange(offset: number, length: number) {
        const scriptPtr = this.assertScriptNotNull();
        // Insert into rope
        this.api.instanceExports.flatsql_script_erase_text_range(scriptPtr, offset, length);
    }
    /// Convert a rope to a string
    public toString(): string {
        const scriptPtr = this.assertScriptNotNull();
        const result = this.api.instanceExports.flatsql_script_to_string(scriptPtr);
        const resultBuffer = this.api.readResult(result);
        const text = this.api.decoder.decode(resultBuffer.getData());
        resultBuffer.delete();
        return text;
    }
}
