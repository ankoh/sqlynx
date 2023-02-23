export * as proto from './gen/flatsql/proto';

export class Parser {
    encoder: TextEncoder;
    decoder: TextDecoder;
    instance: WebAssembly.Instance;
    instanceExports: ParserModuleExports;
    memory: WebAssembly.Memory;

    public constructor(instance: WebAssembly.Instance) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.instance = instance;
        const parserExports = instance.exports;
        const parserMemory = parserExports['memory'] as unknown as WebAssembly.Memory;
        this.memory = parserMemory;
        this.instanceExports = {
            flatsql_new_result: parserExports['flatsql_new_result'] as () => number,
            flatsql_new_string: parserExports['flatsql_new_string'] as (n: number) => number,
            flatsql_delete_result: parserExports['flatsql_delete_result'] as (n: number) => void,
            flatsql_delete_string: parserExports['flatsql_delete_string'] as (n: number) => void,
            flatsql_parse: parserExports['flatsql_parse'] as (result: number, text: number, textLength: number) => void,
        };
    }

    public static async instantiateStreaming(response: PromiseLike<Response>): Promise<Parser> {
        const importStubs = {
            wasi_snapshot_preview1: {
                proc_exit: (code: number) => console.error(`proc_exit(${code})`),
                environ_sizes_get: () => console.error(`environ_sizes_get()`),
                environ_get: (environ: number, buf: number) => console.error(`environ_get(${environ}, ${buf})`),
                fd_fdstat_get: (fd: number) => console.error(`fd_fdstat_get(${fd})`),
                fd_seek: (fd: number, offset: number, whence: number) => console.error(`fd_seek(${fd}, ${offset}, ${whence})`),
                fd_write: (fd: number, iovs: number) => console.error(`fd_write(${fd}, ${iovs})`),
                fd_read: (fd: number, iovs: number) => console.error(`fd_read(${fd}, ${iovs})`),
                fd_close: (fd: number) => console.error(`fd_close(${fd})`),
            },
        };
        const streaming = await WebAssembly.instantiateStreaming(response, importStubs);
        const instance = streaming.instance;
        const startFn = instance.exports['_start'] as () => number;
        startFn();
        return new Parser(instance);
    }

    public parseUtf8(textBuffers: Uint8Array[], textByteLength: number): WasmBuffer {
        // Copy all UTF-8 chunks to the Wasm memory
        const textPtr = this.instanceExports.flatsql_new_string(textByteLength);
        const heapU8 = new Uint8Array(this.memory.buffer);
        let writer = textPtr;
        for (const textBuffer of textBuffers) {
            heapU8.subarray(writer, textBuffer.length).set(textBuffer);
            writer += textBuffer.length;
        }
        // Parse the text
        return this.parseImpl(textPtr, textByteLength);
    }

    public parseString(text: string): WasmBuffer {
        // Copy string to the Wasm memory
        const textEncoded = this.encoder.encode(text);
        const textPtr = this.instanceExports.flatsql_new_string(textEncoded.length);
        const heapU8 = new Uint8Array(this.memory.buffer);
        heapU8.subarray(textPtr, textPtr + textEncoded.length).set(textEncoded);
        // Parse the text
        return this.parseImpl(textPtr, textEncoded.length);
    }

    protected parseImpl(textPtr: number, textLength: number): WasmBuffer {
        const resultPtr = this.instanceExports.flatsql_new_result();
        this.instanceExports.flatsql_parse(resultPtr, textPtr, textLength);
        this.instanceExports.flatsql_delete_string(textPtr);
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        const dataLength = heapU32[resultPtrU32 + 1];
        const dataPtr = heapU32[resultPtrU32 + 2];
        const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
        if (statusCode == 0) {
            return new WasmBuffer(this, resultPtr, dataArray);
        } else {
            const error = this.decoder.decode(dataArray);
            this.instanceExports.flatsql_delete_result(resultPtr);
            throw new Error(error);
        }
    }
}

interface ParserModuleExports {
    flatsql_new_result: () => number;
    flatsql_new_string: (n: number) => number;
    flatsql_delete_result: (ptr: number) => void;
    flatsql_delete_string: (ptr: number) => void;
    flatsql_parse: (result: number, text: number, textLength: number) => void;
}

export class WasmBuffer {
    parser: Parser;
    resultPtr: number | null;
    data: Uint8Array;

    public constructor(parser: Parser, resultPtr: number, data: Uint8Array) {
        this.parser = parser;
        this.resultPtr = resultPtr;
        this.data = data;
    }
    public delete() {
        if (this.resultPtr) {
            this.parser.instanceExports.flatsql_delete_result(this.resultPtr);
        }
        this.resultPtr = null;
    }
    public getDataCopy(): Uint8Array {
        const copy = new Uint8Array(new ArrayBuffer(this.data.byteLength));
        copy.set(this.data);
        return copy;
    }
    public getData(): Uint8Array {
        return this.data;
    }
}