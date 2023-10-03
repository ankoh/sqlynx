import * as proto from '../gen/flatsql/proto';
import * as flatbuffers from 'flatbuffers';

interface FlatSQLModuleExports {
    flatsql_version: () => number;
    flatsql_malloc: (length: number) => number;
    flatsql_free: (ptr: number) => void;
    flatsql_result_delete: (ptr: number) => void;
    flatsql_script_new: (id: number) => number;
    flatsql_script_delete: (ptr: number) => void;
    flatsql_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    flatsql_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    flatsql_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    flatsql_script_to_string: (ptr: number) => number;
    flatsql_script_format: (ptr: number) => number;
    flatsql_script_scan: (ptr: number) => number;
    flatsql_script_parse: (ptr: number) => number;
    flatsql_script_analyze: (ptr: number, external: number) => number;
    flatsql_script_reindex: (ptr: number) => number;
    flatsql_script_move_cursor: (ptr: number, offset: number) => number;
    flatsql_script_complete_at_cursor: (ptr: number, limit: number) => number;
    flatsql_script_get_statistics: (ptr: number) => number;
    flatsql_schemagraph_new: () => number;
    flatsql_schemagraph_delete: (ptr: number) => void;
    flatsql_schemagraph_describe: (ptr: number) => number;
    flatsql_schemagraph_configure: (
        ptr: number,
        iterationsClustering: number,
        iterationsRefinement: number,
        forceScaling: number,
        cooldownFactor: number,
        repulsionForce: number,
        edgeAttractionForce: number,
        gravityForce: number,
        initialRadius: number,
        boardWidth: number,
        boardHeight: number,
        tableWidth: number,
        tableHeight: number,
        tableMargin: number,
        gridSize: number,
    ) => void;
    flatsql_schemagraph_load_script: (ptr: number, script: number) => number;
}

type InstantiateWasmCallback = (stubs: WebAssembly.Imports) => PromiseLike<WebAssembly.WebAssemblyInstantiatedSource>;

interface FlatBufferObject<T> {
    __init(i: number, bb: flatbuffers.ByteBuffer): T;
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
            flatsql_version: parserExports['flatsql_version'] as () => number,
            flatsql_malloc: parserExports['flatsql_malloc'] as (length: number) => number,
            flatsql_free: parserExports['flatsql_free'] as (ptr: number) => void,
            flatsql_result_delete: parserExports['flatsql_result_delete'] as (ptr: number) => void,
            flatsql_script_new: parserExports['flatsql_script_new'] as (id: number) => number,
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
            flatsql_script_format: parserExports['flatsql_script_format'] as (ptr: number) => number,
            flatsql_script_scan: parserExports['flatsql_script_scan'] as (ptr: number) => number,
            flatsql_script_parse: parserExports['flatsql_script_parse'] as (ptr: number) => number,
            flatsql_script_analyze: parserExports['flatsql_script_analyze'] as (
                ptr: number,
                external: number,
            ) => number,
            flatsql_script_reindex: parserExports['flatsql_script_reindex'] as (ptr: number) => number,
            flatsql_script_get_statistics: parserExports['flatsql_script_get_statistics'] as (ptr: number) => number,
            flatsql_script_move_cursor: parserExports['flatsql_script_move_cursor'] as (
                ptr: number,
                offset: number,
            ) => number,
            flatsql_script_complete_at_cursor: parserExports['flatsql_script_complete_at_cursor'] as (
                ptr: number,
                limit: number,
            ) => number,
            flatsql_schemagraph_new: parserExports['flatsql_schemagraph_new'] as () => number,
            flatsql_schemagraph_delete: parserExports['flatsql_schemagraph_delete'] as (ptr: number) => void,
            flatsql_schemagraph_describe: parserExports['flatsql_schemagraph_describe'] as (ptr: number) => number,
            flatsql_schemagraph_configure: parserExports['flatsql_schemagraph_configure'] as (
                ptr: number,
                iterationCount: number,
                forceScaling: number,
                cooldownFactor: number,
                repulsionForce: number,
                edgeAttractionForce: number,
                gravityForce: number,
                initialRadius: number,
                boardWidth: number,
                boardHeight: number,
                tableWidth: number,
                tableHeight: number,
                tableMargin: number,
                gridSize: number,
            ) => void,
            flatsql_schemagraph_load_script: parserExports['flatsql_schemagraph_load_script'] as (
                ptr: number,
                script: number,
            ) => number,
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
        instanceRef.instance = new FlatSQL(instance);
        return instanceRef.instance;
    }

    public createScript(context: number): FlatSQLScript {
        if (context == 0xffffffff) {
            throw new Error('context id 0xFFFFFFFF is reserved');
        }
        const scriptPtr = this.instanceExports.flatsql_script_new(context);
        return new FlatSQLScript(this, scriptPtr);
    }

    public createSchemaGraph(): FlatSQLSchemaGraph {
        const graphPtr = this.instanceExports.flatsql_schemagraph_new();
        return new FlatSQLSchemaGraph(this, graphPtr);
    }

    public getVersionText(): string {
        const versionPtr = this.instanceExports.flatsql_version();
        const heapU8 = new Uint8Array(this.memory.buffer);
        const heapU32 = new Uint32Array(this.memory.buffer);
        const dataPtr = heapU32[versionPtr / 4];
        const dataLength = heapU32[versionPtr / 4 + 1];
        const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
        return this.decoder.decode(dataArray);
    }

    public readResult<T extends FlatBufferObject<T>>(resultPtr: number) {
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
            this.instanceExports.flatsql_result_delete(resultPtr);
            throw new Error(error);
        }
    }
}

export namespace QualifiedID {
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
        return QualifiedID.getIndex(value) == 0xffffffff;
    }
    /// Read a name
    export function readName(
        value: Value,
        scripts: {
            [context: number]: proto.ParsedScript | null;
        },
    ): string | null {
        if (QualifiedID.isNull(value)) {
            return null;
        }
        const key = QualifiedID.getContext(value);
        return scripts[key]?.nameDictionary(QualifiedID.getIndex(value)) ?? null;
    }
    /// Read a table name
    export function readTableName(
        name: proto.QualifiedTableName,
        scripts: {
            [context: number]: proto.ParsedScript | null;
        },
    ) {
        const database = QualifiedID.readName(name.databaseName(), scripts);
        const schema = QualifiedID.readName(name.schemaName(), scripts);
        const table = QualifiedID.readName(name.tableName(), scripts);
        return { database, schema, table };
    }
    /// Read a table name
    export function readColumnName(
        name: proto.QualifiedColumnName,
        scripts: {
            [context: number]: proto.ParsedScript | null;
        },
    ) {
        const column = QualifiedID.readName(name.columnName(), scripts);
        const alias = QualifiedID.readName(name.tableAlias(), scripts);
        return { column, alias };
    }
}

export class FlatBufferRef<T extends FlatBufferObject<T>> {
    /// The FlatSQL api
    api: FlatSQL;
    /// The result pointer
    resultPtr: number | null;
    /// The data pointer
    dataPtr: number | null;
    /// The data length
    dataLength: number;

    public constructor(api: FlatSQL, resultPtr: number, dataPtr: number, dataLength: number) {
        this.api = api;
        this.resultPtr = resultPtr;
        this.dataPtr = dataPtr;
        this.dataLength = dataLength;
    }
    /// Delete the buffer
    public delete() {
        if (this.resultPtr) {
            this.api.instanceExports.flatsql_result_delete(this.resultPtr);
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

export class FlatSQLScript {
    /// The FlatSQL api
    api: FlatSQL;
    /// The script pointer
    scriptPtr: number | null;

    public constructor(api: FlatSQL, graphPtr: number) {
        this.api = api;
        this.scriptPtr = graphPtr;
    }
    /// Delete a graph
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
        const text = this.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Parse the script
    public scan(): FlatBufferRef<proto.ScannedScript> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_scan(scriptPtr);
        return this.api.readResult<proto.ScannedScript>(resultPtr);
    }
    /// Parse the script
    public parse(): FlatBufferRef<proto.ParsedScript> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_parse(scriptPtr);
        return this.api.readResult<proto.ParsedScript>(resultPtr);
    }
    /// Analyze the script (optionally with an external script)
    public analyze(external: FlatSQLScript | null = null): FlatBufferRef<proto.AnalyzedScript> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_analyze(scriptPtr, external?.scriptPtr ?? 0);
        return this.api.readResult<proto.AnalyzedScript>(resultPtr);
    }
    /// Pretty print the SQL string
    public format(): string {
        const scriptPtr = this.assertScriptNotNull();
        const result = this.api.instanceExports.flatsql_script_format(scriptPtr);
        const resultBuffer = this.api.readResult(result);
        const text = this.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Update the index
    public reindex(): boolean {
        const scriptPtr = this.assertScriptNotNull();
        const status = this.api.instanceExports.flatsql_script_reindex(scriptPtr);
        return status == proto.StatusCode.OK;
    }
    /// Move the cursor
    public moveCursor(textOffset: number): FlatBufferRef<proto.ScriptCursorInfo> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_move_cursor(scriptPtr, textOffset);
        return this.api.readResult<proto.ScriptCursorInfo>(resultPtr);
    }
    /// Complete at the cursor position
    public completeAtCursor(limit: number): FlatBufferRef<proto.Completion> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_complete_at_cursor(scriptPtr, limit);
        return this.api.readResult<proto.Completion>(resultPtr);
    }
    /// Get the script statistics.
    /// Timings are useless in some browsers today.
    /// For example, Firefox rounds to millisecond precision, so all our step timings will be 0 for most input.
    /// One way out might be COEP but we cannot easily set that with GitHub pages.
    /// https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing#reduced_precision
    public getStatistics(): FlatBufferRef<proto.ScriptStatistics> {
        const scriptPtr = this.assertScriptNotNull();
        const resultPtr = this.api.instanceExports.flatsql_script_get_statistics(scriptPtr);
        return this.api.readResult<proto.ScriptStatistics>(resultPtr);
    }
}

export interface FlatSQLSchemaGraphConfig {
    iterationsClustering: number;
    iterationsRefinement: number;
    forceScaling: number;
    cooldownFactor: number;
    repulsionForce: number;
    edgeAttractionForce: number;
    gravityForce: number;
    initialRadius: number;
    boardWidth: number;
    boardHeight: number;
    tableWidth: number;
    tableHeight: number;
    tableMargin: number;
    gridSize: number;
}

export class FlatSQLSchemaGraph {
    /// The FlatSQL api
    api: FlatSQL;
    /// The graph pointer
    graphPtr: number | null;

    public constructor(api: FlatSQL, graphPtr: number) {
        this.api = api;
        this.graphPtr = graphPtr;
    }
    /// Delete the graph
    public delete() {
        if (this.graphPtr) {
            this.api.instanceExports.flatsql_schemagraph_delete(this.graphPtr);
        }
        this.graphPtr = null;
    }
    /// Make sure the graph is not null
    protected assertGraphNotNull(): number {
        if (this.graphPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.graphPtr!;
    }

    /// Configure the graph
    public configure(config: FlatSQLSchemaGraphConfig) {
        const graphPtr = this.assertGraphNotNull();
        this.api.instanceExports.flatsql_schemagraph_configure(
            graphPtr,
            config.iterationsClustering,
            config.iterationsRefinement,
            config.forceScaling,
            config.cooldownFactor,
            config.repulsionForce,
            config.edgeAttractionForce,
            config.gravityForce,
            config.initialRadius,
            config.boardWidth,
            config.boardHeight,
            config.tableWidth,
            config.tableHeight,
            config.tableMargin,
            config.gridSize,
        );
    }
    /// Load a script
    public loadScript(script: FlatSQLScript) {
        const graphPtr = this.assertGraphNotNull();
        const resultPtr = this.api.instanceExports.flatsql_schemagraph_load_script(graphPtr, script.scriptPtr);
        return this.api.readResult<proto.SchemaGraphLayout>(resultPtr);
    }
    /// Describe the graph
    public describe() {
        const graphPtr = this.assertGraphNotNull();
        const resultPtr = this.api.instanceExports.flatsql_schemagraph_describe(graphPtr);
        return this.api.readResult<proto.SchemaGraphDebugInfo>(resultPtr);
    }
}
