import * as proto from '../gen/flatsql/proto';
import * as flatbuffers from 'flatbuffers';

interface FlatSQLModuleExports {
    flatsql_version: () => number;
    flatsql_malloc: (length: number) => number;
    flatsql_free: (ptr: number) => void;
    flatsql_result_delete: (ptr: number) => void;
    flatsql_script_new: () => number;
    flatsql_script_delete: (ptr: number) => void;
    flatsql_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    flatsql_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    flatsql_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    flatsql_script_to_string: (ptr: number) => number;
    flatsql_script_format: (ptr: number) => number;
    flatsql_script_scan: (ptr: number) => number;
    flatsql_script_parse: (ptr: number) => number;
    flatsql_script_analyze: (ptr: number, external: number) => number;
    flatsql_script_update_completion_index: (ptr: number) => number;
    flatsql_schemagraph_new: () => number;
    flatsql_schemagraph_delete: (ptr: number) => void;
    flatsql_schemagraph_configure: (
        ptr: number,
        iterationCount: number,
        forceScaling: number,
        cooldownFactor: number,
        cooldownUntil: number,
        repulsionForce: number,
        edgeAttractionForce: number,
        gravityForce: number,
        initialRadius: number,
        boardWidth: number,
        boardHeight: number,
        tableWidth: number,
        tableConstantHeight: number,
        tableColumnHeight: number,
        tableMaxHeight: number,
        tableMargin: number,
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
            flatsql_script_format: parserExports['flatsql_script_format'] as (ptr: number) => number,
            flatsql_script_scan: parserExports['flatsql_script_scan'] as (ptr: number) => number,
            flatsql_script_parse: parserExports['flatsql_script_parse'] as (ptr: number) => number,
            flatsql_script_analyze: parserExports['flatsql_script_analyze'] as (
                ptr: number,
                external: number,
            ) => number,
            flatsql_script_update_completion_index: parserExports['flatsql_script_update_completion_index'] as (
                ptr: number,
            ) => number,
            flatsql_schemagraph_new: parserExports['flatsql_schemagraph_new'] as () => number,
            flatsql_schemagraph_delete: parserExports['flatsql_schemagraph_delete'] as (ptr: number) => void,
            flatsql_schemagraph_configure: parserExports['flatsql_schemagraph_configure'] as (
                ptr: number,
                iterationCount: number,
                forceScaling: number,
                cooldownFactor: number,
                cooldownUntil: number,
                repulsionForce: number,
                edgeAttractionForce: number,
                gravityForce: number,
                initialRadius: number,
                boardWidth: number,
                boardHeight: number,
                tableWidth: number,
                tableConstantHeight: number,
                tableColumnHeight: number,
                tableMaxHeight: number,
                tableMargin: number,
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

export class FlatID {
    /// Mask index
    public static maskIndex(value: number): number {
        return value & ~(0b1 << 31);
    }
    /// Is a null id?
    public static isNull(value: number): boolean {
        return value == 0xffffffff;
    }
    /// Is an external id?
    public static isExternal(value: number): boolean {
        return value >> 31 != 0;
    }
    /// Read a name
    public static readName(
        value: number,
        script: proto.ParsedScript,
        external: proto.ParsedScript | null = null,
    ): string | null {
        if (FlatID.isNull(value)) {
            return null;
        }
        if (FlatID.isExternal(value)) {
            return external?.nameDictionary(FlatID.maskIndex(value)) ?? null;
        } else {
            return script.nameDictionary(FlatID.maskIndex(value)) ?? null;
        }
    }
    /// Read a table name
    public static readTableName(
        name: proto.QualifiedTableName,
        script: proto.ParsedScript,
        external: proto.ParsedScript | null = null,
    ) {
        const database = FlatID.readName(name.databaseName(), script, external);
        const schema = FlatID.readName(name.schemaName(), script, external);
        const table = FlatID.readName(name.tableName(), script, external);
        return { database, schema, table };
    }
    /// Read a table name
    public static readColumnName(
        name: proto.QualifiedColumnName,
        script: proto.ParsedScript,
        external: proto.ParsedScript | null = null,
    ) {
        const column = FlatID.readName(name.columnName(), script, external);
        const alias = FlatID.readName(name.tableAlias(), script, external);
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
    /// Update the completion index
    public updateCompletionIndex(): boolean {
        const scriptPtr = this.assertScriptNotNull();
        const status = this.api.instanceExports.flatsql_script_update_completion_index(scriptPtr);
        return status == proto.StatusCode.OK;
    }
}

export interface FlatSQLSchemaGraphConfig {
    iterationCount: number;
    forceScaling: number;
    cooldownFactor: number;
    cooldownUntil: number;
    repulsionForce: number;
    edgeAttractionForce: number;
    gravityForce: number;
    initialRadius: number;
    boardWidth: number;
    boardHeight: number;
    tableWidth: number;
    tableConstantHeight: number;
    tableColumnHeight: number;
    tableMaxHeight: number;
    tableMargin: number;
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
            config.iterationCount,
            config.forceScaling,
            config.cooldownFactor,
            config.cooldownUntil,
            config.repulsionForce,
            config.edgeAttractionForce,
            config.gravityForce,
            config.initialRadius,
            config.boardWidth,
            config.boardHeight,
            config.tableWidth,
            config.tableConstantHeight,
            config.tableColumnHeight,
            config.tableMaxHeight,
            config.tableMargin,
        );
    }
    /// Load a script
    public loadScript(script: FlatSQLScript) {
        const graphPtr = this.assertGraphNotNull();
        const resultPtr = this.api.instanceExports.flatsql_schemagraph_load_script(graphPtr, script.scriptPtr);
        return this.api.readResult<proto.SchemaGraphLayout>(resultPtr);
    }
}
