import * as proto from '../gen/sqlynx/proto';
import * as flatbuffers from 'flatbuffers';

interface SQLynxModuleExports {
    sqlynx_version: () => number;
    sqlynx_malloc: (length: number) => number;
    sqlynx_free: (ptr: number) => void;
    sqlynx_result_delete: (ptr: number) => void;

    sqlynx_script_new: (
        id: number,
        db_name_ptr: number,
        db_name_length: number,
        schema_name_ptr: number,
        schema_name_length: number,
    ) => number;
    sqlynx_script_delete: (ptr: number) => void;
    sqlynx_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    sqlynx_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    sqlynx_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    sqlynx_script_to_string: (ptr: number) => number;
    sqlynx_script_format: (ptr: number) => number;
    sqlynx_script_scan: (ptr: number) => number;
    sqlynx_script_parse: (ptr: number) => number;
    sqlynx_script_analyze: (ptr: number, path_ptr: number) => number;
    sqlynx_script_move_cursor: (ptr: number, offset: number) => number;
    sqlynx_script_complete_at_cursor: (ptr: number, limit: number) => number;
    sqlynx_script_get_statistics: (ptr: number) => number;

    sqlynx_schema_registry_new: () => number;
    sqlynx_schema_registry_delete: (ptr: number) => number;
    sqlynx_schema_registry_add_script: (path_ptr: number, script_ptr: number, rank: number) => number;
    sqlynx_schema_registry_update_script: (path_ptr: number, script_ptr: number) => number;
    sqlynx_schema_registry_erase_script: (path_ptr: number, script_ptr: number) => number;

    sqlynx_schema_layout_new: () => number;
    sqlynx_schema_layout_delete: (ptr: number) => void;
    sqlynx_schema_layout_configure: (
        ptr: number,
        boardWidth: number,
        boardHeight: number,
        cellWidth: number,
        cellHeight: number,
        tableWidth: number,
        tableHeight: number,
    ) => void;
    sqlynx_schema_layout_load_script: (ptr: number, script: number) => number;
}

type InstantiateWasmCallback = (stubs: WebAssembly.Imports) => PromiseLike<WebAssembly.WebAssemblyInstantiatedSource>;

interface FlatBufferObject<T> {
    __init(i: number, bb: flatbuffers.ByteBuffer): T;
}

export class SQLynx {
    encoder: TextEncoder;
    decoder: TextDecoder;
    instance: WebAssembly.Instance;
    instanceExports: SQLynxModuleExports;
    memory: WebAssembly.Memory;

    public constructor(instance: WebAssembly.Instance) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.instance = instance;
        const parserExports = instance.exports;
        const parserMemory = parserExports['memory'] as unknown as WebAssembly.Memory;
        this.memory = parserMemory;
        this.instanceExports = {
            sqlynx_version: parserExports['sqlynx_version'] as () => number,
            sqlynx_malloc: parserExports['sqlynx_malloc'] as (length: number) => number,
            sqlynx_free: parserExports['sqlynx_free'] as (ptr: number) => void,
            sqlynx_result_delete: parserExports['sqlynx_result_delete'] as (ptr: number) => void,

            sqlynx_script_new: parserExports['sqlynx_script_new'] as (
                id: number,
                db_name_ptr: number,
                db_name_length: number,
                schema_name_ptr: number,
                schema_name_length: number,
            ) => number,
            sqlynx_script_delete: parserExports['sqlynx_script_delete'] as (ptr: number) => void,
            sqlynx_script_insert_text_at: parserExports['sqlynx_script_insert_text_at'] as (
                ptr: number,
                offset: number,
                textPtr: number,
                textLength: number,
            ) => void,
            sqlynx_script_insert_char_at: parserExports['sqlynx_script_insert_char_at'] as (
                ptr: number,
                offset: number,
                character: number,
            ) => void,
            sqlynx_script_erase_text_range: parserExports['sqlynx_script_erase_text_range'] as (
                ptr: number,
                offset: number,
                length: number,
            ) => void,
            sqlynx_script_to_string: parserExports['sqlynx_script_to_string'] as (ptr: number) => number,
            sqlynx_script_format: parserExports['sqlynx_script_format'] as (ptr: number) => number,
            sqlynx_script_scan: parserExports['sqlynx_script_scan'] as (ptr: number) => number,
            sqlynx_script_parse: parserExports['sqlynx_script_parse'] as (ptr: number) => number,
            sqlynx_script_analyze: parserExports['sqlynx_script_analyze'] as (ptr: number, external: number) => number,
            sqlynx_script_get_statistics: parserExports['sqlynx_script_get_statistics'] as (ptr: number) => number,
            sqlynx_script_move_cursor: parserExports['sqlynx_script_move_cursor'] as (
                ptr: number,
                offset: number,
            ) => number,
            sqlynx_script_complete_at_cursor: parserExports['sqlynx_script_complete_at_cursor'] as (
                ptr: number,
                limit: number,
            ) => number,

            sqlynx_schema_registry_new: parserExports['sqlynx_schema_registry_new'] as () => number,
            sqlynx_schema_registry_delete: parserExports['sqlynx_schema_registry_delete'] as (ptr: number) => number,
            sqlynx_schema_registry_add_script: parserExports['sqlynx_schema_registry_add_script'] as (
                path_ptr: number,
                index: number,
                script_ptr: number,
            ) => number,
            sqlynx_schema_registry_update_script: parserExports['sqlynx_schema_registry_update_script'] as (
                path_ptr: number,
                script_ptr: number,
            ) => number,
            sqlynx_schema_registry_erase_script: parserExports['sqlynx_schema_registry_erase_script'] as (
                path_ptr: number,
                script_ptr: number,
            ) => number,

            sqlynx_schema_layout_new: parserExports['sqlynx_schema_layout_new'] as () => number,
            sqlynx_schema_layout_delete: parserExports['sqlynx_schema_layout_delete'] as (ptr: number) => void,
            sqlynx_schema_layout_configure: parserExports['sqlynx_schema_layout_configure'] as (
                ptr: number,
                boardWidth: number,
                boardHeight: number,
                cellWidth: number,
                cellHeight: number,
                tableWidth: number,
                tableHeight: number,
            ) => void,
            sqlynx_schema_layout_load_script: parserExports['sqlynx_schema_layout_load_script'] as (
                ptr: number,
                script: number,
            ) => number,
        };
    }

    public static async create(instantiate: InstantiateWasmCallback): Promise<SQLynx> {
        const instanceRef: { instance: SQLynx | null } = { instance: null };
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
                clock_time_get: (_id: number, _precision: number, ptr: number) => {
                    const instance = instanceRef.instance!;
                    const buffer = new BigUint64Array(instance.memory.buffer);
                    const nowMs = performance.now();
                    const nowNs = BigInt(Math.floor(nowMs * 1000 * 1000));
                    buffer[ptr / 8] = nowNs;
                    return 0;
                },
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
        instanceRef.instance = new SQLynx(instance);
        return instanceRef.instance;
    }

    public allocateString(text: string): [number, number] {
        // Empty strings are passed as null pointer
        if (text.length == 0) {
            return [0, 0];
        }
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const textBegin = this.instanceExports.sqlynx_malloc(text.length * 3);
        const textBuffer = new Uint8Array(this.memory.buffer).subarray(textBegin, textBegin + text.length * 3);
        const textEncoded = this.encoder.encodeInto(text, textBuffer);
        // Nothing written?
        if (textEncoded.written == undefined || textEncoded.written == 0) {
            this.instanceExports.sqlynx_free(textBegin);
            throw new Error(`failed to allocate a string of size ${text.length}`);
        }
        return [textBegin, textEncoded.written];
    }

    public createScript(
        context: number,
        databaseName: string | null = null,
        schemaName: string | null = null,
    ): SQLynxScript {
        if (context == 0xffffffff) {
            throw new Error('context id 0xFFFFFFFF is reserved');
        }
        let databaseNamePtr = 0,
            databaseNameLength = 0,
            schemaNamePtr = 0,
            schemaNameLength = 0;
        if (databaseName != null) {
            [databaseNamePtr, databaseNameLength] = this.allocateString(databaseName);
        }
        if (schemaName != null) {
            try {
                [schemaNamePtr, schemaNameLength] = this.allocateString(schemaName);
            } catch (e: any) {
                this.instanceExports.sqlynx_free(databaseNamePtr);
                throw e;
            }
        }
        const scriptPtr = this.instanceExports.sqlynx_script_new(
            context,
            databaseNamePtr,
            databaseNameLength,
            schemaNamePtr,
            schemaNameLength,
        );
        this.instanceExports.sqlynx_free(schemaNamePtr);
        this.instanceExports.sqlynx_free(databaseNamePtr);
        return new SQLynxScript(this, scriptPtr);
    }

    public createSchemaRegistry(): SQLynxSchemaRegistry {
        const pathPtr = this.instanceExports.sqlynx_schema_registry_new();
        return new SQLynxSchemaRegistry(this, pathPtr);
    }

    public createSchemaLayout(): SQLynxSchemaLayout {
        const graphPtr = this.instanceExports.sqlynx_schema_layout_new();
        return new SQLynxSchemaLayout(this, graphPtr);
    }

    public getVersionText(): string {
        const versionPtr = this.instanceExports.sqlynx_version();
        const heapU8 = new Uint8Array(this.memory.buffer);
        const heapU32 = new Uint32Array(this.memory.buffer);
        const dataPtr = heapU32[versionPtr / 4];
        const dataLength = heapU32[versionPtr / 4 + 1];
        const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
        return this.decoder.decode(dataArray);
    }

    public readFlatBufferResult<T extends FlatBufferObject<T>>(resultPtr: number) {
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        const dataLength = heapU32[resultPtrU32 + 1];
        const dataPtr = heapU32[resultPtrU32 + 2];
        if (statusCode == proto.StatusCode.OK) {
            return new FlatBufferRef<T>(this, resultPtr, dataPtr, dataLength);
        } else {
            const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
            const error = this.decoder.decode(dataArray);
            this.instanceExports.sqlynx_result_delete(resultPtr);
            throw new Error(error);
        }
    }

    public readStatusResult(resultPtr: number) {
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        const dataLength = heapU32[resultPtrU32 + 1];
        const dataPtr = heapU32[resultPtrU32 + 2];
        if (statusCode == proto.StatusCode.OK) {
            this.instanceExports.sqlynx_result_delete(resultPtr);
        } else {
            const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
            const error = this.decoder.decode(dataArray);
            this.instanceExports.sqlynx_result_delete(resultPtr);
            throw new Error(error);
        }
    }
}

export namespace ExternalID {
    export type Value = bigint;

    /// Create the qualified id
    export function create(context: number, value: number): bigint {
        if (context == 0xffffffff) {
            throw new Error('context id 0xFFFFFFFF is reserved');
        }
        return (BigInt(context) << 32n) | BigInt(value);
    }
    /// Get the context id
    export function getContext(value: Value): number {
        return Number(value >> 32n);
    }
    /// Mask index
    export function getIndex(value: Value): number {
        return Number(value & 0xffffffffn);
    }
    /// Is a null id?
    export function isNull(value: Value): boolean {
        return ExternalID.getIndex(value) == 0xffffffff;
    }
}

export class FlatBufferRef<T extends FlatBufferObject<T>> {
    /// The SQLynx api
    api: SQLynx;
    /// The result pointer
    resultPtr: number | null;
    /// The data pointer
    dataPtr: number | null;
    /// The data length
    dataLength: number;

    public constructor(api: SQLynx, resultPtr: number, dataPtr: number, dataLength: number) {
        this.api = api;
        this.resultPtr = resultPtr;
        this.dataPtr = dataPtr;
        this.dataLength = dataLength;
    }
    /// Delete the buffer
    public delete() {
        if (this.resultPtr) {
            this.api.instanceExports.sqlynx_result_delete(this.resultPtr);
        }
        this.resultPtr = null;
    }
    /// Get the data
    public get data(): Uint8Array {
        const begin = this.dataPtr ?? 0;
        return new Uint8Array(this.api.memory.buffer).subarray(begin, begin + this.dataLength);
    }
    /// Copy the data into a buffer
    public copy(): Uint8Array {
        const copy = new Uint8Array(new ArrayBuffer(this.data.byteLength));
        copy.set(this.data);
        return copy;
    }
    // Get the flatbuffer object
    // C.f. getRootAsAnalyzedScript
    public read(obj: T): T {
        const bb = new flatbuffers.ByteBuffer(this.data);
        return obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
}

export const NULL_POINTER_EXCEPTION = new Error('tried to access a null pointer');

export class SQLynxScript {
    /// The SQLynx api
    api: SQLynx;
    /// The script pointer
    scriptPtr: number | null;

    public constructor(api: SQLynx, graphPtr: number) {
        this.api = api;
        this.scriptPtr = graphPtr;
    }
    /// Delete a graph
    public delete() {
        if (this.scriptPtr) {
            this.api.instanceExports.sqlynx_script_delete(this.scriptPtr);
        }
        this.scriptPtr = null;
    }
    /// Make sure the script is not null
    public assertNotNull(): number {
        if (this.scriptPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.scriptPtr!;
    }
    /// Insert text at an offset
    public insertTextAt(offset: number, text: string) {
        const scriptPtr = this.assertNotNull();
        // Short-circuit inserting texts of length 1
        if (text.length == 1) {
            this.api.instanceExports.sqlynx_script_insert_char_at(scriptPtr, offset, text.charCodeAt(0));
            return;
        }
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const [textBegin, textLength] = this.api.allocateString(text);
        // Insert into rope
        this.api.instanceExports.sqlynx_script_insert_text_at(scriptPtr, offset, textBegin, textLength);
        // Delete text buffer
        this.api.instanceExports.sqlynx_free(textBegin);
    }
    /// Earse a range of characters
    public eraseTextRange(offset: number, length: number) {
        const scriptPtr = this.assertNotNull();
        // Insert into rope
        this.api.instanceExports.sqlynx_script_erase_text_range(scriptPtr, offset, length);
    }
    /// Convert a rope to a string
    public toString(): string {
        const scriptPtr = this.assertNotNull();
        const result = this.api.instanceExports.sqlynx_script_to_string(scriptPtr);
        const resultBuffer = this.api.readFlatBufferResult(result);
        const text = this.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Parse the script
    public scan(): FlatBufferRef<proto.ScannedScript> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_scan(scriptPtr);
        return this.api.readFlatBufferResult<proto.ScannedScript>(resultPtr);
    }
    /// Parse the script
    public parse(): FlatBufferRef<proto.ParsedScript> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_parse(scriptPtr);
        return this.api.readFlatBufferResult<proto.ParsedScript>(resultPtr);
    }
    /// Analyze the script (optionally with an external script)
    public analyze(searchPath: SQLynxSchemaRegistry | null = null): FlatBufferRef<proto.AnalyzedScript> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_analyze(
            scriptPtr,
            searchPath == null ? 0 : searchPath.registryPtr,
        );
        return this.api.readFlatBufferResult<proto.AnalyzedScript>(resultPtr);
    }
    /// Pretty print the SQL string
    public format(): string {
        const scriptPtr = this.assertNotNull();
        const result = this.api.instanceExports.sqlynx_script_format(scriptPtr);
        const resultBuffer = this.api.readFlatBufferResult(result);
        const text = this.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Move the cursor
    public moveCursor(textOffset: number): FlatBufferRef<proto.ScriptCursorInfo> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_move_cursor(scriptPtr, textOffset);
        return this.api.readFlatBufferResult<proto.ScriptCursorInfo>(resultPtr);
    }
    /// Complete at the cursor position
    public completeAtCursor(limit: number): FlatBufferRef<proto.Completion> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_complete_at_cursor(scriptPtr, limit);
        return this.api.readFlatBufferResult<proto.Completion>(resultPtr);
    }
    /// Get the script statistics.
    /// Timings are useless in some browsers today.
    /// For example, Firefox rounds to millisecond precision, so all our step timings will be 0 for most input.
    /// One way out might be COEP but we cannot easily set that with GitHub pages.
    /// https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing#reduced_precision
    public getStatistics(): FlatBufferRef<proto.ScriptStatistics> {
        const scriptPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_script_get_statistics(scriptPtr);
        return this.api.readFlatBufferResult<proto.ScriptStatistics>(resultPtr);
    }
}

export class SQLynxSchemaRegistry {
    /// The SQLynx api
    api: SQLynx;
    /// The graph pointer
    registryPtr: number | null;

    public constructor(api: SQLynx, pathPtr: number) {
        this.api = api;
        this.registryPtr = pathPtr;
    }
    /// Delete the graph
    public delete() {
        if (this.registryPtr) {
            this.api.instanceExports.sqlynx_schema_registry_delete(this.registryPtr);
        }
        this.registryPtr = null;
    }
    /// Make sure the search path is not null
    protected assertNotNull(): number {
        if (this.registryPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.registryPtr!;
    }
    /// Append a script in the search path
    public addScript(script: SQLynxScript, rank: number) {
        const registryPtr = this.assertNotNull();
        const scriptPtr = script.assertNotNull();
        const result = this.api.instanceExports.sqlynx_schema_registry_add_script(registryPtr, scriptPtr, rank);
        this.api.readStatusResult(result);
    }
    /// Update a script in the search path
    public updateScript(script: SQLynxScript) {
        const registryPtr = this.assertNotNull();
        const scriptPtr = script.assertNotNull();
        const result = this.api.instanceExports.sqlynx_schema_registry_update_script(registryPtr, scriptPtr);
        this.api.readStatusResult(result);
    }
}

export interface SQLynxSchemaLayoutConfig {
    boardWidth: number;
    boardHeight: number;
    cellWidth: number;
    cellHeight: number;
    tableWidth: number;
    tableHeight: number;
}

export class SQLynxSchemaLayout {
    /// The SQLynx api
    api: SQLynx;
    /// The graph pointer
    graphPtr: number | null;

    public constructor(api: SQLynx, graphPtr: number) {
        this.api = api;
        this.graphPtr = graphPtr;
    }
    /// Delete the graph
    public delete() {
        if (this.graphPtr) {
            this.api.instanceExports.sqlynx_schema_layout_delete(this.graphPtr);
        }
        this.graphPtr = null;
    }
    /// Make sure the graph is not null
    public assertNotNull(): number {
        if (this.graphPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.graphPtr!;
    }
    /// Configure the graph
    public configure(config: SQLynxSchemaLayoutConfig) {
        const graphPtr = this.assertNotNull();
        this.api.instanceExports.sqlynx_schema_layout_configure(
            graphPtr,
            config.boardWidth,
            config.boardHeight,
            config.cellWidth,
            config.cellHeight,
            config.tableWidth,
            config.tableHeight,
        );
    }
    /// Load a script
    public loadScript(script: SQLynxScript) {
        const graphPtr = this.assertNotNull();
        const resultPtr = this.api.instanceExports.sqlynx_schema_layout_load_script(graphPtr, script.scriptPtr);
        return this.api.readFlatBufferResult<proto.SchemaLayout>(resultPtr);
    }
}
