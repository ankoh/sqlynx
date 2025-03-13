import * as proto from '../gen/sqlynx/proto/index.js';
import * as flatbuffers from 'flatbuffers';

interface SQLynxModuleExports {
    sqlynx_version: () => number;
    sqlynx_malloc: (length: number) => number;
    sqlynx_free: (ptr: number) => void;
    sqlynx_delete_result: (ptr: number) => void;

    sqlynx_script_new: (catalog: number, id: number) => number;
    sqlynx_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    sqlynx_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    sqlynx_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    sqlynx_script_replace_text: (ptr: number, text: number, textLength: number) => void;
    sqlynx_script_to_string: (ptr: number) => number;
    sqlynx_script_format: (ptr: number) => number;
    sqlynx_script_scan: (ptr: number) => number;
    sqlynx_script_parse: (ptr: number) => number;
    sqlynx_script_analyze: (ptr: number) => number;
    sqlynx_script_move_cursor: (ptr: number, offset: number) => number;
    sqlynx_script_complete_at_cursor: (ptr: number, limit: number) => number;
    sqlynx_script_get_statistics: (ptr: number) => number;

    sqlynx_catalog_new: (
        default_db_name_ptr: number,
        default_db_name_length: number,
        default_schema_name_ptr: number,
        default_schema_name_length: number) => number;
    sqlynx_catalog_clear: (catalog_ptr: number) => void;
    sqlynx_catalog_describe_entries: (catalog_ptr: number) => number;
    sqlynx_catalog_describe_entries_of: (catalog_ptr: number, external_id: number) => number;
    sqlynx_catalog_flatten: (catalog_ptr: number) => number;
    sqlynx_catalog_load_script: (catalog_ptr: number, script_ptr: number, rank: number) => number;
    sqlynx_catalog_update_script: (catalog_ptr: number, script_ptr: number) => number;
    sqlynx_catalog_drop_script: (catalog_ptr: number, script_ptr: number) => void;
    sqlynx_catalog_add_descriptor_pool: (catalog_ptr: number, external_id: number, rank: number) => number;
    sqlynx_catalog_drop_descriptor_pool: (catalog_ptr: number, external_id: number) => void;
    sqlynx_catalog_add_schema_descriptor: (
        catalog_ptr: number,
        external_id: number,
        data_ptr: number,
        data_size: number,
    ) => number;
    sqlynx_catalog_get_statistics: (ptr: number) => number;
}

type InstantiateWasmCallback = (stubs: WebAssembly.Imports) => PromiseLike<WebAssembly.WebAssemblyInstantiatedSource>;

interface FlatBufferObject<T> {
    __init(i: number, bb: flatbuffers.ByteBuffer): T;
}

const SCRIPT_TYPE = Symbol('SCRIPT_TYPE');
const CATALOG_TYPE = Symbol('CATALOG_TYPE');

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
        this.memory = instance.exports['memory'] as unknown as WebAssembly.Memory;
        this.instanceExports = {
            sqlynx_version: instance.exports['sqlynx_version'] as () => number,
            sqlynx_malloc: instance.exports['sqlynx_malloc'] as (length: number) => number,
            sqlynx_free: instance.exports['sqlynx_free'] as (ptr: number) => void,
            sqlynx_delete_result: instance.exports['sqlynx_delete_result'] as (ptr: number) => void,

            sqlynx_script_new: instance.exports['sqlynx_script_new'] as (catalog: number, id: number) => number,
            sqlynx_catalog_clear: instance.exports['sqlynx_catalog_clear'] as (ptr: number) => void,
            sqlynx_script_insert_text_at: instance.exports['sqlynx_script_insert_text_at'] as (
                ptr: number,
                offset: number,
                textPtr: number,
                textLength: number,
            ) => void,
            sqlynx_script_insert_char_at: instance.exports['sqlynx_script_insert_char_at'] as (
                ptr: number,
                offset: number,
                character: number,
            ) => void,
            sqlynx_script_erase_text_range: instance.exports['sqlynx_script_erase_text_range'] as (
                ptr: number,
                offset: number,
                length: number,
            ) => void,
            sqlynx_script_replace_text: instance.exports['sqlynx_script_replace_text'] as (
                ptr: number,
                text: number,
                textLength: number,
            ) => void,
            sqlynx_script_to_string: instance.exports['sqlynx_script_to_string'] as (ptr: number) => number,
            sqlynx_script_format: instance.exports['sqlynx_script_format'] as (ptr: number) => number,
            sqlynx_script_scan: instance.exports['sqlynx_script_scan'] as (ptr: number) => number,
            sqlynx_script_parse: instance.exports['sqlynx_script_parse'] as (ptr: number) => number,
            sqlynx_script_analyze: instance.exports['sqlynx_script_analyze'] as (ptr: number) => number,
            sqlynx_script_get_statistics: instance.exports['sqlynx_script_get_statistics'] as (ptr: number) => number,
            sqlynx_script_move_cursor: instance.exports['sqlynx_script_move_cursor'] as (
                ptr: number,
                offset: number,
            ) => number,
            sqlynx_script_complete_at_cursor: instance.exports['sqlynx_script_complete_at_cursor'] as (
                ptr: number,
                limit: number,
            ) => number,

            sqlynx_catalog_new: instance.exports['sqlynx_catalog_new'] as (
                db_name_ptr: number,
                db_name_length: number,
                schema_name_ptr: number,
                schema_name_length: number,
            ) => number,
            sqlynx_catalog_describe_entries: instance.exports['sqlynx_catalog_describe_entries'] as (
                catalog_ptr: number,
            ) => number,
            sqlynx_catalog_describe_entries_of: instance.exports['sqlynx_catalog_describe_entries_of'] as (
                catalog_ptr: number,
                entry_id: number,
            ) => number,
            sqlynx_catalog_flatten: instance.exports['sqlynx_catalog_flatten'] as (
                catalog_ptr: number,
            ) => number,
            sqlynx_catalog_load_script: instance.exports['sqlynx_catalog_load_script'] as (
                catalog_ptr: number,
                index: number,
                script_ptr: number,
            ) => number,
            sqlynx_catalog_update_script: instance.exports['sqlynx_catalog_update_script'] as (
                catalog_ptr: number,
                script_ptr: number,
            ) => number,
            sqlynx_catalog_drop_script: instance.exports['sqlynx_catalog_drop_script'] as (
                catalog_ptr: number,
                script_ptr: number,
            ) => void,
            sqlynx_catalog_add_descriptor_pool: instance.exports['sqlynx_catalog_add_descriptor_pool'] as (
                catalog_ptr: number,
                rank: number,
                external_id: number,
            ) => number,
            sqlynx_catalog_drop_descriptor_pool: instance.exports['sqlynx_catalog_drop_descriptor_pool'] as (
                catalog_ptr: number,
                external_id: number,
            ) => void,
            sqlynx_catalog_add_schema_descriptor: instance.exports['sqlynx_catalog_add_schema_descriptor'] as (
                catalog_ptr: number,
                external_id: number,
                data_ptr: number,
                data_size: number,
            ) => number,
            sqlynx_catalog_get_statistics: instance.exports['sqlynx_catalog_get_statistics'] as (catalog_ptr: number) => number,
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

    public copyString(text: string): [number, number] {
        // Empty strings are passed as null pointer
        if (text.length == 0) {
            return [0, 0];
        }
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const textBegin = this.instanceExports.sqlynx_malloc(text.length * 3);
        // Allocation failed?
        if (textBegin == 0) {
            throw new Error(`failed to allocate a string of size ${text.length}`);
        }
        // Encode as UTF-8
        const textBuffer = new Uint8Array(this.memory.buffer).subarray(textBegin, textBegin + text.length * 3);
        const textEncoded = this.encoder.encodeInto(text, textBuffer);
        if (textEncoded.written == undefined || textEncoded.written == 0) {
            this.instanceExports.sqlynx_free(textBegin);
            throw new Error(`failed to encode a string of size ${text.length}`);
        }
        return [textBegin, textEncoded.written];
    }

    public copyBuffer(src: Uint8Array): [number, number] {
        if (src.length == 0) {
            return [0, 0];
        }
        const ptr = this.instanceExports.sqlynx_malloc(src.length);
        if (ptr == 0) {
            throw new Error(`failed to allocate a buffer of size ${src.length}`);
        }
        const dst = new Uint8Array(this.memory.buffer).subarray(ptr, ptr + src.length);
        dst.set(src);
        return [ptr, src.length];
    }

    public createScript(
        catalog: SQLynxCatalog,
        id: number,
        databaseName: string | null = null,
        schemaName: string | null = null,
    ): SQLynxScript {
        if (id == 0xffffffff) {
            throw new Error('context id 0xFFFFFFFF is reserved');
        }
        let databaseNamePtr = 0,
            databaseNameLength = 0,
            schemaNamePtr = 0,
            schemaNameLength = 0;
        if (databaseName != null) {
            [databaseNamePtr, databaseNameLength] = this.copyString(databaseName);
        }
        if (schemaName != null) {
            try {
                [schemaNamePtr, schemaNameLength] = this.copyString(schemaName);
            } catch (e: any) {
                this.instanceExports.sqlynx_free(databaseNamePtr);
                throw e;
            }
        }
        const catalogPtr = catalog?.ptr.assertNotNull() ?? 0;
        const result = this.instanceExports.sqlynx_script_new(catalogPtr, id);
        const scriptPtr = this.readPtrResult(SCRIPT_TYPE, result);
        return new SQLynxScript(scriptPtr);
    }

    public createCatalog(
        databaseName: string | null = null,
        schemaName: string | null = null,
    ): SQLynxCatalog {
        let databaseNamePtr = 0,
            databaseNameLength = 0,
            schemaNamePtr = 0,
            schemaNameLength = 0;
        if (databaseName != null) {
            [databaseNamePtr, databaseNameLength] = this.copyString(databaseName);
        }
        if (schemaName != null) {
            try {
                [schemaNamePtr, schemaNameLength] = this.copyString(schemaName);
            } catch (e: any) {
                this.instanceExports.sqlynx_free(databaseNamePtr);
                throw e;
            }
        }
        const result = this.instanceExports.sqlynx_catalog_new(
            databaseNamePtr, // pass ownership over buffer
            databaseNameLength,
            schemaNamePtr, // pass ownership over buffer
            schemaNameLength,
        );
        const ptr = this.readPtrResult(CATALOG_TYPE, result);
        return new SQLynxCatalog(ptr);
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

    public readPtrResult<T extends symbol>(ptrType: T, resultPtr: number) {
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        if (statusCode == proto.StatusCode.OK) {
            const ownerPtr = heapU32[resultPtrU32 + 3];
            return new Ptr(ptrType, this, resultPtr, ownerPtr);
        } else {
            const dataLength = heapU32[resultPtrU32 + 1];
            const dataPtr = heapU32[resultPtrU32 + 2];
            const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
            const error = this.decoder.decode(dataArray);
            this.instanceExports.sqlynx_delete_result(resultPtr);
            throw new Error(error);
        }
    }

    public readFlatBufferResult<T extends FlatBufferObject<T>>(resultPtr: number, factory: () => T) {
        const heapU8 = new Uint8Array(this.memory.buffer);
        const resultPtrU32 = resultPtr / 4;
        const heapU32 = new Uint32Array(this.memory.buffer);
        const statusCode = heapU32[resultPtrU32];
        const dataLength = heapU32[resultPtrU32 + 1];
        const dataPtr = heapU32[resultPtrU32 + 2];
        if (statusCode == proto.StatusCode.OK) {
            return new FlatBufferPtr<T>(this, resultPtr, dataPtr, dataLength, factory);
        } else {
            const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
            const error = this.decoder.decode(dataArray);
            this.instanceExports.sqlynx_delete_result(resultPtr);
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
            this.instanceExports.sqlynx_delete_result(resultPtr);
        } else {
            const dataArray = heapU8.subarray(dataPtr, dataPtr + dataLength);
            const error = this.decoder.decode(dataArray);
            this.instanceExports.sqlynx_delete_result(resultPtr);
            throw new Error(error);
        }
    }
}

export const NULL_POINTER_EXCEPTION = new Error('tried to access a null pointer');

export class Ptr<T extends symbol> {
    /// The object type
    public readonly type: symbol;
    /// The SQLynx api
    public readonly api: SQLynx;
    /// The pointer
    public readonly ptr: number;
    /// The result pointer
    resultPtr: number | null;

    public constructor(type: T, api: SQLynx, resultPtr: number, ownerPtr: number) {
        this.type = type;
        this.api = api;
        this.ptr = ownerPtr;
        this.resultPtr = resultPtr;
    }
    /// Delete the object
    public delete() {
        if (this.resultPtr != null) {
            this.api.instanceExports.sqlynx_delete_result(this.resultPtr);
            this.resultPtr = null;
        }
    }
    /// Make sure the pointer is not null
    public assertNotNull(): number {
        if (this.resultPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.ptr;
    }
    /// Is null?
    public isNull(): boolean {
        return this.resultPtr != null;
    }
    /// Get the object pointer
    public get(): number | null {
        return this.ptr;
    }
}

export class FlatBufferPtr<T extends FlatBufferObject<T>> {
    /// The SQLynx api
    api: SQLynx;
    /// The result pointer
    resultPtr: number | null;
    /// The data pointer
    dataPtr: number | null;
    /// The data length
    dataLength: number;
    /// The factory
    factory: () => T;

    public constructor(api: SQLynx, resultPtr: number, dataPtr: number, dataLength: number, factory: () => T) {
        this.api = api;
        this.resultPtr = resultPtr;
        this.dataPtr = dataPtr;
        this.dataLength = dataLength;
        this.factory = factory;
    }
    /// Delete the buffer
    public delete() {
        if (this.resultPtr) {
            this.api.instanceExports.sqlynx_delete_result(this.resultPtr);
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
    public read(obj: T | null = null): T {
        obj = obj ?? this.factory();
        const bb = new flatbuffers.ByteBuffer(this.data);
        return obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
}

export class ScannerError extends Error {
    public scanned: FlatBufferPtr<proto.ScannedScript>;
    constructor(scanned: FlatBufferPtr<proto.ScannedScript>, firstError: proto.Error) {
        super(firstError.message());
        this.scanned = scanned;
    }
}
export class ParserError extends Error {
    public parsed: FlatBufferPtr<proto.ParsedScript>;
    constructor(parsed: FlatBufferPtr<proto.ParsedScript>, firstError: proto.Error) {
        super(firstError.message());
        this.parsed = parsed;
    }
}


export class SQLynxScript {
    public readonly ptr: Ptr<typeof SCRIPT_TYPE>;

    public constructor(ptr: Ptr<typeof SCRIPT_TYPE>) {
        this.ptr = ptr;
    }
    /// Delete a graph
    public delete() {
        this.ptr.delete();
    }
    /// Insert text at an offset
    public insertTextAt(offset: number, text: string) {
        const scriptPtr = this.ptr.assertNotNull();
        // Short-circuit inserting texts of length 1
        if (text.length == 1) {
            this.ptr.api.instanceExports.sqlynx_script_insert_char_at(scriptPtr, offset, text.charCodeAt(0));
            return;
        }
        const [textBegin, textLength] = this.ptr.api.copyString(text);
        this.ptr.api.instanceExports.sqlynx_script_insert_text_at(scriptPtr, offset, textBegin, textLength);
    }
    /// Earse a range of characters
    public eraseTextRange(offset: number, length: number) {
        const scriptPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.sqlynx_script_erase_text_range(scriptPtr, offset, length);
    }
    /// Replace the text text
    public replaceText(text: string) {
        const scriptPtr = this.ptr.assertNotNull();
        const [textBegin, textLength] = this.ptr.api.copyString(text);
        this.ptr.api.instanceExports.sqlynx_script_replace_text(scriptPtr, textBegin, textLength);
    }
    /// Convert a rope to a string
    public toString(): string {
        const scriptPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_script_to_string(scriptPtr);
        const resultBuffer = this.ptr.api.readFlatBufferResult(result, () => null);
        const text = this.ptr.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Scan the script.
    /// Use `throwOnError` with caution since you might leak other pointers!
    public scan(throwOnError: boolean = false): FlatBufferPtr<proto.ScannedScript> {
        const scriptPtr = this.ptr.assertNotNull();
        const rawResultPtr = this.ptr.api.instanceExports.sqlynx_script_scan(scriptPtr);
        const resultPtr = this.ptr.api.readFlatBufferResult<proto.ScannedScript>(rawResultPtr, () => new proto.ScannedScript());
        if (throwOnError) {
            const script = resultPtr.read();
            if (script.errorsLength() > 0) {
                throw new ScannerError(resultPtr, script.errors(0));
            }
        }
        return resultPtr;
    }
    /// Parse the script.
    /// Use `throwOnError` with caution since you might leak other pointers!
    public parse(throwOnError: boolean = false): FlatBufferPtr<proto.ParsedScript> {
        const scriptPtr = this.ptr.assertNotNull();
        const rawResultPtr = this.ptr.api.instanceExports.sqlynx_script_parse(scriptPtr);
        const resultPtr = this.ptr.api.readFlatBufferResult<proto.ParsedScript>(rawResultPtr, () => new proto.ParsedScript());
        if (throwOnError) {
            const script = resultPtr.read();
            if (script.errorsLength() > 0) {
                throw new ParserError(resultPtr, script.errors(0));
            }
        }
        return resultPtr;
    }
    /// Analyze the script (optionally with an external script)
    public analyze(): FlatBufferPtr<proto.AnalyzedScript> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.instanceExports.sqlynx_script_analyze(scriptPtr);
        return this.ptr.api.readFlatBufferResult<proto.AnalyzedScript>(resultPtr, () => new proto.AnalyzedScript());
    }
    /// Pretty print the SQL string
    public format(): string {
        const scriptPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_script_format(scriptPtr);
        const resultBuffer = this.ptr.api.readFlatBufferResult(result, () => null);
        const text = this.ptr.api.decoder.decode(resultBuffer.data);
        resultBuffer.delete();
        return text;
    }
    /// Move the cursor
    public moveCursor(textOffset: number): FlatBufferPtr<proto.ScriptCursor> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.instanceExports.sqlynx_script_move_cursor(scriptPtr, textOffset);
        return this.ptr.api.readFlatBufferResult<proto.ScriptCursor>(resultPtr, () => new proto.ScriptCursor());
    }
    /// Complete at the cursor position
    public completeAtCursor(limit: number): FlatBufferPtr<proto.Completion> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.instanceExports.sqlynx_script_complete_at_cursor(scriptPtr, limit);
        return this.ptr.api.readFlatBufferResult<proto.Completion>(resultPtr, () => new proto.Completion());
    }
    /// Get the script statistics.
    /// Timings are useless in some browsers today.
    /// For example, Firefox rounds to millisecond precision, so all our step timings will be 0 for most foundations.
    /// One way out might be COEP but we cannot easily set that with GitHub pages.
    /// https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing#reduced_precision
    public getStatistics(): FlatBufferPtr<proto.ScriptStatistics> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.instanceExports.sqlynx_script_get_statistics(scriptPtr);
        return this.ptr.api.readFlatBufferResult<proto.ScriptStatistics>(resultPtr, () => new proto.ScriptStatistics());
    }
}

export class SQLynxCatalogSnapshotReader {
    public catalogReader: proto.FlatCatalog;
    nameDictionary: (string | null)[];

    /// Construct a snapshot reader with a name dictionary
    constructor(catalog: proto.FlatCatalog, nameDictionary: (string | null)[]) {
        this.catalogReader = catalog;
        this.nameDictionary = nameDictionary;
    }
    /// Read a name
    public readName(nameId: number): string {
        let name = this.nameDictionary[nameId];
        if (name == null) {
            name = this.catalogReader.nameDictionary(nameId);
            this.nameDictionary[nameId] = name;
        }
        return name;
    }
}

export class SQLynxCatalogSnapshot {
    snapshot: FlatBufferPtr<proto.FlatCatalog>;
    nameDictionary: (string | null)[];

    constructor(snapshot: FlatBufferPtr<proto.FlatCatalog>) {
        this.snapshot = snapshot;
        this.nameDictionary = [];
    }
    /// Delete a snapshot
    public delete() {
        this.snapshot.delete();
    }
    /// Read a snapshot
    public read(): SQLynxCatalogSnapshotReader {
        const reader = this.snapshot.read();
        return new SQLynxCatalogSnapshotReader(reader, this.nameDictionary);
    }
}

export class SQLynxCatalog {
    public readonly ptr: Ptr<typeof CATALOG_TYPE> | null;
    public snapshot: SQLynxCatalogSnapshot | null;

    public constructor(ptr: Ptr<typeof CATALOG_TYPE>) {
        this.ptr = ptr;
    }
    /// Delete the snapshot if there is one
    protected deleteSnapshot() {
        if (this.snapshot != null) {
            this.snapshot.delete();
            this.snapshot = null;
        }
    }
    /// Delete the graph
    public delete() {
        this.ptr.delete();
    }
    /// Reset a catalog
    public clear(): void {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.sqlynx_catalog_clear(catalogPtr);
    }
    /// Describe catalog entries
    public describeEntries(): FlatBufferPtr<proto.CatalogEntries> {
        const catalogPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_catalog_describe_entries(catalogPtr);
        return this.ptr.api.readFlatBufferResult<proto.CatalogEntries>(result, () => new proto.CatalogEntries());
    }
    /// Describe catalog entries
    public describeEntriesOf(id: number): FlatBufferPtr<proto.CatalogEntries> {
        const catalogPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_catalog_describe_entries_of(catalogPtr, id);
        return this.ptr.api.readFlatBufferResult<proto.CatalogEntries>(result, () => new proto.CatalogEntries());
    }
    /// Export a catalog snapshot
    public createSnapshot(): SQLynxCatalogSnapshot {
        if (this.snapshot != null) {
            return this.snapshot;
        }
        const catalogPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_catalog_flatten(catalogPtr);
        const snapshot = this.ptr.api.readFlatBufferResult<proto.FlatCatalog>(result, () => new proto.FlatCatalog());
        this.snapshot = new SQLynxCatalogSnapshot(snapshot);
        return this.snapshot;
    }
    /// Add a script in the registry
    public loadScript(script: SQLynxScript, rank: number) {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        const scriptPtr = script.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_catalog_load_script(catalogPtr, scriptPtr, rank);
        this.ptr.api.readStatusResult(result);
    }
    /// Update a script from the registry
    public dropScript(script: SQLynxScript) {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        const scriptPtr = script.ptr.assertNotNull();
        this.ptr.api.instanceExports.sqlynx_catalog_drop_script(catalogPtr, scriptPtr);
    }
    /// Add an external schema
    public addDescriptorPool(id: number, rank: number) {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        const result = this.ptr.api.instanceExports.sqlynx_catalog_add_descriptor_pool(catalogPtr, id, rank);
        this.ptr.api.readStatusResult(result);
    }
    /// Drop an external schema
    public dropDescriptorPool(id: number) {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.sqlynx_catalog_drop_descriptor_pool(catalogPtr, id);
    }
    /// Add a schema descriptor to a descriptor pool
    public addSchemaDescriptor(id: number, buffer: Uint8Array) {
        this.deleteSnapshot();
        const catalogPtr = this.ptr.assertNotNull();
        const [bufferPtr, bufferLength] = this.ptr.api.copyBuffer(buffer);
        const result = this.ptr.api.instanceExports.sqlynx_catalog_add_schema_descriptor(
            catalogPtr,
            id,
            bufferPtr, // pass ownership over buffer
            bufferLength,
        );
        this.ptr.api.readStatusResult(result);
    }
    /// Add a schema descriptor to a descriptor pool
    public addSchemaDescriptorT(id: number, descriptor: proto.SchemaDescriptorT) {
        this.deleteSnapshot();
        const builder = new flatbuffers.Builder();
        const descriptorOffset = descriptor.pack(builder);
        builder.finish(descriptorOffset);
        const buffer = builder.asUint8Array();
        this.addSchemaDescriptor(id, buffer);
    }
    /// Get the catalog statistics.
    public getStatistics(): FlatBufferPtr<proto.CatalogStatistics> {
        const catalogPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.instanceExports.sqlynx_catalog_get_statistics(catalogPtr);
        return this.ptr.api.readFlatBufferResult<proto.CatalogStatistics>(resultPtr, () => new proto.CatalogStatistics());
    }
}

export interface SQLynxQueryGraphLayoutConfig {
    boardWidth: number;
    boardHeight: number;
    cellWidth: number;
    cellHeight: number;
    tableWidth: number;
    tableHeight: number;
}

export namespace ContextObjectID {
    export type Value = bigint;

    /// Create the external id
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
    export function getObject(value: Value): number {
        return Number(value & 0xffffffffn);
    }
    /// Is a null id?
    export function isNull(value: Value): boolean {
        return ContextObjectID.getObject(value) == 0xffffffff;
    }
}

export namespace ContextObjectChildID {
    export type Value = bigint;

    /// Create the external id
    export function create(parent: bigint, child: number): bigint {
        return (parent << 32n) | BigInt(child);
    }
    /// Get the context id
    export function getParent(value: Value): bigint {
        return value >> 32n;
    }
    /// Mask index
    export function getChild(value: Value): number {
        return Number(value & 0xffffffffn);
    }
}
