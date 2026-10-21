import * as buffers from './buffers.js';
import * as flatbuffers from 'flatbuffers';

import * as glue from './wasm/dashql_core.js';
import { decodeBatchResult, encodeBatchRequest } from './batch.js';
import type { BatchRequest, BatchResult } from './batch.js';

/// The wasm-bindgen module of the Rust core (`packages/dashql-core-wasm`).
/// Every module that re-exports the core bindings (e.g. the shell module) satisfies this interface.
export type DashQLBindings = Pick<
    typeof glue,
    | 'Catalog'
    | 'Script'
    | 'ScriptBatch'
    | 'ScriptSession'
    | 'ScriptExecution'
    | 'SessionList'
    | 'PlanViewModel'
    | 'plan'
    | 'processBatch'
    | 'parseVegaLiteToVisualize'
>;

export interface DashQLModuleOptions {
    /// The wasm binary
    wasmBinary?: Uint8Array | ArrayBuffer;
    /// A precompiled wasm module, takes precedence over the binary
    module?: WebAssembly.Module;
}

interface FlatBufferObject<T, O> {
    __init(i: number, bb: flatbuffers.ByteBuffer): T;
    unpack(): O;
}

/// A native object of the wasm module
interface NativeObject {
    free(): void;
}

const ANALYZED_SCRIPT_TYPE = Symbol('ANALYZED_SCRIPT_TYPE');
const CATALOG_ENTRIES_TYPE = Symbol('CATALOG_ENTRIES_TYPE');
const CATALOG_STATISTICS_TYPE = Symbol('CATALOG_STATISTICS_TYPE');
const CATALOG_TYPE = Symbol('CATALOG_TYPE');
const COMPLETION_TYPE = Symbol('COMPLETION_TYPE');
const CURSOR_TYPE = Symbol('CURSOR_TYPE');
const SCRIPT_SESSION_TYPE = Symbol('SCRIPT_SESSION_TYPE');
const EDITOR_UPDATE_TYPE = Symbol('EDITOR_UPDATE_TYPE');
const SCRIPT_DIFF_TYPE = Symbol('SCRIPT_DIFF_TYPE');
const SCRIPT_COMPILATION_TYPE = Symbol('SCRIPT_COMPILATION_TYPE');
const SCRIPT_EXECUTION_TYPE = Symbol('SCRIPT_EXECUTION_TYPE');
const SCRIPT_EXECUTION_UPDATE_TYPE = Symbol('SCRIPT_EXECUTION_UPDATE_TYPE');
const EXECUTION_GRAPH_TYPE = Symbol('EXECUTION_GRAPH_TYPE');
const FLAT_CATALOG_TYPE = Symbol('FLAT_CATALOG_TYPE');
const FLAT_PLAN_VIEW_MODEL_TYPE = Symbol('FLAT_PLAN_VIEW_MODEL_TYPE');
const PARSED_SCRIPT_TYPE = Symbol('PARSED_SCRIPT_TYPE');
const PLAN_VIEW_MODEL_TYPE = Symbol('PLAN_VIEW_MODEL_TYPE');
const SCRIPT_STATISTICS_TYPE = Symbol('SCRIPT_STATISTICS_TYPE');
const SCRIPT_TYPE = Symbol('SCRIPT_TYPE');

/// Load the wasm binary next to this module
async function loadDefaultWasm(): Promise<Uint8Array | URL> {
    const url = new URL('./wasm/dashql_core.wasm', import.meta.url);
    if (url.protocol === 'file:') {
        // Node: fetch does not support file URLs. The specifier is not static to keep bundlers away.
        const fs = 'node:fs/promises';
        const { readFile } = await import(/* @vite-ignore */ fs);
        return new Uint8Array(await readFile(url));
    }
    return url;
}

export class DashQL {
    encoder: TextEncoder;
    decoder: TextDecoder;
    /// The wasm-bindgen module
    bindings: DashQLBindings;
    /// The native objects owned by this instance
    registeredMemory: Set<Ptr<symbol>>;

    public constructor(bindings: DashQLBindings) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.bindings = bindings;
        this.registeredMemory = new Set();
    }

    /// Create a DashQL instance.
    /// A wasm-bindgen module is instantiated once per JS module: instances share the wasm memory
    /// but own their native objects independently.
    public static async create(options?: DashQLModuleOptions): Promise<DashQL> {
        const moduleOrPath = options?.module ?? options?.wasmBinary ?? await loadDefaultWasm();
        await glue.default({ module_or_path: moduleOrPath });
        // A plain copy of the module namespace, the namespace itself is frozen
        return new DashQL({ ...glue });
    }

    public registerMemory(ptr: Ptr<symbol>) {
        this.registeredMemory.add(ptr);
    }
    public unregisterMemory(ptr: Ptr<symbol>) {
        this.registeredMemory.delete(ptr);
    }
    /// Destroy all native objects of this instance.
    /// Test-only teardown helper; JS objects that still reference them become null pointers.
    /// Objects are freed in reverse registration order, scripts before their catalogs.
    public resetUnsafe() {
        const entries = Array.from(this.registeredMemory);
        for (let i = entries.length - 1; i >= 0; --i) {
            try {
                entries[i].destroy();
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
        this.registeredMemory = new Set();
    }

    public processBatch(request: BatchRequest): BatchResult {
        return decodeBatchResult(this.bindings.processBatch(encodeBatchRequest(request)));
    }

    public createScript(
        catalog: DashQLCatalog,
        _databaseName: string | null = null,
        _schemaName: string | null = null,
    ): DashQLScript {
        const native = new this.bindings.Script(catalog.ptr.assertNotNull());
        return new DashQLScript(new Ptr(SCRIPT_TYPE, this, native));
    }

    public createCatalog(): DashQLCatalog {
        return new DashQLCatalog(new Ptr(CATALOG_TYPE, this, new this.bindings.Catalog()));
    }

    public createScriptSession(
        catalog: DashQLCatalog,
        offsetUnit = buffers.editor.EditorOffsetUnit.UTF16_CODE_UNITS,
    ): DashQLScriptSession {
        const native = new this.bindings.ScriptSession(catalog.ptr.assertNotNull(), offsetUnit);
        return new DashQLScriptSession(new Ptr(SCRIPT_SESSION_TYPE, this, native));
    }

    /// Plan current analysis in notebook order; callers prepare and publish sessions explicitly.
    public plan(sessions: readonly DashQLScriptSession[]): FlatBufferPtr<buffers.execution.ExecutionGraph> {
        if (!Array.isArray(sessions)) {
            throw new TypeError('planner sessions must be an array');
        }
        const natives = Array.from(sessions, session => {
            if (!(session instanceof DashQLScriptSession)) {
                throw new TypeError('planner input must be a DashQLScriptSession');
            }
            if (session.ptr.api !== this) {
                throw new Error('planner session belongs to a different DashQL instance');
            }
            return session.ptr.assertNotNull();
        });
        const list = new this.bindings.SessionList();
        try {
            for (const native of natives) {
                list.add(native);
            }
            return new FlatBufferPtr(EXECUTION_GRAPH_TYPE, this, this.bindings.plan(list), () => new buffers.execution.ExecutionGraph());
        } finally {
            list.free();
        }
    }

    public createPlanViewModel(layoutConfig: buffers.view.PlanLayoutConfigT): DashQLPlanViewModel {
        const ptr = new Ptr(PLAN_VIEW_MODEL_TYPE, this, new this.bindings.PlanViewModel());
        return new DashQLPlanViewModel(ptr, layoutConfig);
    }

    /// Transcode a (constrained) Vega-Lite JSON spec into a VISUALIZE statement.
    /// Returns an empty string if the JSON is malformed. The source clause is derived from the
    /// spec's `data` member.
    public parseVegaLiteToVisualize(vegaLiteJson: string): string {
        return this.decoder.decode(this.bindings.parseVegaLiteToVisualize(this.encoder.encode(vegaLiteJson)));
    }
}

export const NULL_POINTER_EXCEPTION = new Error('tried to access a null pointer');

/// An owned native object of the wasm module
export class Ptr<T extends symbol, O extends NativeObject = any> {
    /// The object type
    public readonly type: T;
    /// The DashQL api
    public readonly api: DashQL;
    /// The native object
    private object: O | null;

    public constructor(type: T, api: DashQL, object: O) {
        this.type = type;
        this.api = api;
        this.object = object;
        api.registerMemory(this);
    }
    /// Delete the object
    public destroy() {
        const object = this.object;
        if (object == null) {
            return;
        }
        this.object = null;
        this.api.unregisterMemory(this);
        object.free();
    }
    /// Make sure the object was not deleted
    public assertNotNull(): O {
        if (this.object == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.object;
    }
    /// Is null?
    public isNull(): boolean {
        return this.object == null;
    }
    /// Get the object
    public get(): O | null {
        return this.object;
    }
}

/// A FlatBuffer returned by the wasm module. The bytes are owned by JS.
export class FlatBufferPtr<T extends FlatBufferObject<T, O>, O = any> {
    /// The object type
    public readonly type: symbol;
    /// The DashQL api
    public readonly api: DashQL;
    /// The bytes
    private bytes: Uint8Array | null;
    /// The factory
    factory: () => T;

    public constructor(type: symbol, api: DashQL, bytes: Uint8Array, factory: () => T) {
        this.type = type;
        this.api = api;
        this.bytes = bytes;
        this.factory = factory;
    }
    /// Release the buffer
    public destroy() {
        this.bytes = null;
    }
    /// Is null?
    public isNull(): boolean {
        return this.bytes == null;
    }
    /// The data length
    public get dataLength(): number {
        return this.bytes?.byteLength ?? 0;
    }
    /// Get the data
    public get data(): Uint8Array {
        if (this.bytes == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.bytes;
    }
    /// Copy the data into a buffer
    public copy(): Uint8Array {
        return this.data.slice();
    }
    /// Equals a different flatbuffer ptr?
    public equals(other: FlatBufferPtr<T>): boolean {
        return this === other;
    }
    // Get the flatbuffer object
    // C.f. getRootAsAnalyzedScript
    public read(obj: T | null = null): T {
        obj = obj ?? this.factory();
        const bb = new flatbuffers.ByteBuffer(this.data);
        return obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    // Get the flatbuffer object, unpack it and destroy the buffer
    public unpackAndDestroy(obj: T | null = null): O {
        const out = this.read(obj).unpack();
        this.destroy();
        return out;
    }
}

export class ParserError extends Error {
    public parsed: FlatBufferPtr<buffers.parser.ParsedScript>;
    constructor(parsed: FlatBufferPtr<buffers.parser.ParsedScript>, firstError: buffers.parser.Error) {
        super(firstError.message()!);
        this.parsed = parsed;
    }
}

type NativeScriptExecution = glue.ScriptExecution;
type NativeScriptSession = glue.ScriptSession;
type NativeScript = glue.Script;
type NativeCatalog = glue.Catalog;
type NativePlanViewModel = glue.PlanViewModel;

export class DashQLScriptExecution {
    public readonly ptr: Ptr<typeof SCRIPT_EXECUTION_TYPE, NativeScriptExecution>;

    public constructor(ptr: Ptr<typeof SCRIPT_EXECUTION_TYPE, NativeScriptExecution>) {
        this.ptr = ptr;
    }

    public destroy(): void {
        this.ptr.destroy();
    }

    public start(): buffers.execution.ScriptExecutionUpdateT {
        return this.readUpdate(this.ptr.assertNotNull().start());
    }

    public resume(statementResult: buffers.execution.StatementResultT): buffers.execution.ScriptExecutionUpdateT {
        const builder = new flatbuffers.Builder();
        builder.finish(statementResult.pack(builder));
        return this.readUpdate(this.ptr.assertNotNull().resume(builder.asUint8Array()));
    }

    public cancel(): buffers.execution.ScriptExecutionUpdateT {
        return this.readUpdate(this.ptr.assertNotNull().cancel());
    }

    private readUpdate(bytes: Uint8Array): buffers.execution.ScriptExecutionUpdateT {
        return new FlatBufferPtr<buffers.execution.ScriptExecutionUpdate, buffers.execution.ScriptExecutionUpdateT>(
            SCRIPT_EXECUTION_UPDATE_TYPE,
            this.ptr.api,
            bytes,
            () => new buffers.execution.ScriptExecutionUpdate(),
        ).unpackAndDestroy();
    }
}

export class DashQLScriptSession {
    public readonly ptr: Ptr<typeof SCRIPT_SESSION_TYPE, NativeScriptSession>;
    public readonly catalog_entry_id: number;

    public constructor(ptr: Ptr<typeof SCRIPT_SESSION_TYPE, NativeScriptSession>) {
        this.ptr = ptr;
        this.catalog_entry_id = ptr.assertNotNull().catalogEntryId();
    }

    public destroy(): void {
        this.ptr.destroy();
    }

    public startExecution(
        formattingConfig: buffers.formatting.FormattingConfigT = new buffers.formatting.FormattingConfigT(
            buffers.formatting.FormattingDialect.HYPER,
            buffers.formatting.FormattingMode.INLINE,
            120,
            2,
            false,
        ),
    ): DashQLScriptExecution {
        const native = this.ptr.assertNotNull().startExecution(
            formattingConfig.dialect,
            formattingConfig.mode,
            formattingConfig.maxWidth,
            formattingConfig.indentationWidth,
            formattingConfig.debugMode,
        );
        return new DashQLScriptExecution(new Ptr(SCRIPT_EXECUTION_TYPE, this.ptr.api, native));
    }

    public getCatalogEntryId(): number {
        return this.ptr.assertNotNull().catalogEntryId();
    }

    public getText(): string {
        return this.ptr.assertNotNull().text();
    }

    public getTextVersion(): bigint {
        return this.ptr.assertNotNull().textVersion();
    }

    public getStateRevision(): bigint {
        return this.ptr.assertNotNull().stateRevision();
    }

    public getCatalogRevision(): bigint {
        return this.ptr.assertNotNull().catalogRevision();
    }

    public replaceText(expectedTextVersion: bigint, text: string): buffers.editor.EditorUpdateT {
        return this.readUpdate(this.ptr.assertNotNull().replaceText(expectedTextVersion, text));
    }

    public apply(event: buffers.editor.EditorEventT): buffers.editor.EditorUpdateT {
        const session = this.ptr.assertNotNull();
        const builder = new flatbuffers.Builder();
        builder.finish(event.pack(builder));
        return this.readUpdate(session.apply(builder.asUint8Array()));
    }

    public setCursor(expectedTextVersion: bigint, offset: bigint): buffers.editor.EditorUpdateT {
        return this.readUpdate(this.ptr.assertNotNull().setPrimaryCursor(expectedTextVersion, offset));
    }

    public analyze(): buffers.editor.EditorUpdateT {
        return this.readUpdate(this.ptr.assertNotNull().analyze());
    }

    public completeAtCursor(limit: number, keywordCase = buffers.formatting.KeywordCase.LOWER): FlatBufferPtr<buffers.completion.Completion> {
        const bytes = this.ptr.assertNotNull().completeAtCursor(limit, keywordCase);
        return new FlatBufferPtr(COMPLETION_TYPE, this.ptr.api, bytes, () => new buffers.completion.Completion());
    }

    public compileQuery(
        config: buffers.formatting.FormattingConfigT,
        allowExtensions: boolean = true,
        parseIfOutdated: boolean = true,
    ): FlatBufferPtr<buffers.execution.ScriptCompilationResult> {
        const bytes = this.ptr.assertNotNull().compileQuery(
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            allowExtensions,
            parseIfOutdated,
        );
        return new FlatBufferPtr(SCRIPT_COMPILATION_TYPE, this.ptr.api, bytes, () => new buffers.execution.ScriptCompilationResult());
    }

    public format(
        config: buffers.formatting.FormattingConfigT,
        catalog: DashQLCatalog | null = null,
        parseIfOutdated: boolean = true,
    ): DashQLScript {
        const self = this.ptr.assertNotNull();
        const args = [
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            config.keywordCase,
            parseIfOutdated,
        ] as const;
        const native = catalog == null ? self.format(...args) : self.formatInto(...args, catalog.ptr.assertNotNull());
        return new DashQLScript(new Ptr(SCRIPT_TYPE, this.ptr.api, native));
    }

    public rewriteDashboard(
        row: number | null,
        column: number | null,
        width: number,
        height: number,
        parseIfOutdated: boolean = true,
    ): string {
        return this.ptr.assertNotNull().rewriteDashboard(row ?? -1, column ?? -1, width, height, parseIfOutdated);
    }

    public isFullyFormattable(
        config: buffers.formatting.FormattingConfigT,
        parseIfOutdated: boolean = true,
    ): boolean {
        return this.ptr.assertNotNull().isFullyFormattable(
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            parseIfOutdated,
        );
    }

    public computeDiff(target: DashQLScript): FlatBufferPtr<buffers.diff.ScriptDiff> {
        const bytes = this.ptr.assertNotNull().computeDiff(target.ptr.assertNotNull());
        return new FlatBufferPtr(SCRIPT_DIFF_TYPE, this.ptr.api, bytes, () => new buffers.diff.ScriptDiff());
    }

    public loadIntoCatalog(rank: number): void {
        this.ptr.assertNotNull().loadIntoCatalog(rank);
    }

    public dropFromCatalog(): void {
        this.ptr.assertNotNull().dropFromCatalog();
    }

    private readUpdate(bytes: Uint8Array): buffers.editor.EditorUpdateT {
        return new FlatBufferPtr<buffers.editor.EditorUpdate, buffers.editor.EditorUpdateT>(
            EDITOR_UPDATE_TYPE,
            this.ptr.api,
            bytes,
            () => new buffers.editor.EditorUpdate(),
        ).unpackAndDestroy();
    }
}

export class DashQLScript {
    public readonly ptr: Ptr<typeof SCRIPT_TYPE, NativeScript>;
    public readonly catalog_entry_id: number;

    public constructor(ptr: Ptr<typeof SCRIPT_TYPE, NativeScript>) {
        this.ptr = ptr;
        this.catalog_entry_id = ptr.assertNotNull().catalogEntryId();
    }
    /// Delete the script, this drops it from its catalog
    public destroy() {
        this.ptr.destroy();
    }
    /// Get the script id
    public getCatalogEntryId(): number {
        return this.ptr.assertNotNull().catalogEntryId();
    }
    /// Whether formatting can complete without unsupported-node placeholders.
    public isFullyFormattable(config: buffers.formatting.FormattingConfigT, parseIfOutdated: boolean = true): boolean {
        return this.ptr.assertNotNull().isFullyFormattable(
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            parseIfOutdated,
        );
    }
    /// AST node ids that prevent formatting.
    public getUnformattableNodes(config: buffers.formatting.FormattingConfigT, parseIfOutdated: boolean = true): number[] {
        return Array.from(this.ptr.assertNotNull().getUnformattableNodes(
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            parseIfOutdated,
        ));
    }
    /// Insert text at a code point offset
    public insertTextAt(offset: number, text: string) {
        this.ptr.assertNotNull().insertTextAt(offset, text);
    }
    /// Erase a range of code points
    public eraseTextRange(offset: number, length: number) {
        this.ptr.assertNotNull().eraseTextRange(offset, length);
    }
    /// Replace the text
    public replaceText(text: string) {
        this.ptr.assertNotNull().replaceText(text);
    }
    /// Convert the script, or a UTF-8 byte range of it, to a string.
    public toString(offset?: number, length?: number): string {
        return this.ptr.assertNotNull().toString(offset, length);
    }
    /// Return the first parsed statement without its separator or surrounding trivia.
    public getStatementText(parseIfOutdated: boolean = true): string {
        return this.ptr.assertNotNull().getStatementText(parseIfOutdated);
    }
    /// Compile the script into an executable query.
    public compileQuery(
        config: buffers.formatting.FormattingConfigT,
        allowExtensions: boolean = true,
        parseIfOutdated: boolean = true,
    ): FlatBufferPtr<buffers.execution.ScriptCompilationResult> {
        const bytes = this.ptr.assertNotNull().compileQuery(
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            allowExtensions,
            parseIfOutdated,
        );
        return new FlatBufferPtr(SCRIPT_COMPILATION_TYPE, this.ptr.api, bytes, () => new buffers.execution.ScriptCompilationResult());
    }
    /// Parse the script
    public parse() {
        this.ptr.assertNotNull().parse();
    }
    /// Analyze the script (throws exception on error)
    public analyze(parseIfOutdated: boolean = true) {
        this.ptr.assertNotNull().analyze(parseIfOutdated);
    }
    /// Get the parsed script
    public getParsed(): FlatBufferPtr<buffers.parser.ParsedScript> {
        const bytes = this.ptr.assertNotNull().getParsed();
        return new FlatBufferPtr(PARSED_SCRIPT_TYPE, this.ptr.api, bytes, () => new buffers.parser.ParsedScript());
    }
    /// Get the analyzed script
    public getAnalyzed(): FlatBufferPtr<buffers.analyzer.AnalyzedScript> {
        const bytes = this.ptr.assertNotNull().getAnalyzed();
        return new FlatBufferPtr(ANALYZED_SCRIPT_TYPE, this.ptr.api, bytes, () => new buffers.analyzer.AnalyzedScript());
    }
    /// Compute a statement-level semantic diff from this (source/old) script to another (target/new) script
    public computeDiff(target: DashQLScript): FlatBufferPtr<buffers.diff.ScriptDiff> {
        const bytes = this.ptr.assertNotNull().computeDiff(target.ptr.assertNotNull());
        return new FlatBufferPtr(SCRIPT_DIFF_TYPE, this.ptr.api, bytes, () => new buffers.diff.ScriptDiff());
    }
    /// Move the cursor
    public moveCursor(textOffset: number): FlatBufferPtr<buffers.cursor.ScriptCursor> {
        const bytes = this.ptr.assertNotNull().moveCursor(textOffset);
        return new FlatBufferPtr(CURSOR_TYPE, this.ptr.api, bytes, () => new buffers.cursor.ScriptCursor());
    }
    /// Complete at the cursor
    public completeAtCursor(limit: number, keywordCase = buffers.formatting.KeywordCase.LOWER): FlatBufferPtr<buffers.completion.Completion> {
        const bytes = this.ptr.assertNotNull().completeAtCursor(limit, keywordCase);
        return new FlatBufferPtr(COMPLETION_TYPE, this.ptr.api, bytes, () => new buffers.completion.Completion());
    }
    /// Try to complete at cursor
    public tryCompleteAtCursor(limit: number): FlatBufferPtr<buffers.completion.Completion> | null {
        try {
            return this.completeAtCursor(limit);
        } catch (e: unknown) {
            return null;
        }
    }
    /// Get the script statistics.
    /// Timings are useless in some browsers today.
    /// For example, Firefox rounds to millisecond precision, so all our step timings will be 0 for most foundations.
    /// One way out might be COEP but we cannot easily set that with GitHub pages.
    /// https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing#reduced_precision
    public getStatistics(): FlatBufferPtr<buffers.statistics.ScriptStatistics> {
        const bytes = this.ptr.assertNotNull().getStatistics();
        return new FlatBufferPtr(SCRIPT_STATISTICS_TYPE, this.ptr.api, bytes, () => new buffers.statistics.ScriptStatistics());
    }
    /// Format the script
    public format(
        config: buffers.formatting.FormattingConfigT,
        catalog: DashQLCatalog | null = null,
        parseIfOutdated: boolean = true,
    ): DashQLScript {
        const self = this.ptr.assertNotNull();
        const args = [
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            config.keywordCase,
            parseIfOutdated,
        ] as const;
        const native = catalog == null ? self.format(...args) : self.formatInto(...args, catalog.ptr.assertNotNull());
        return new DashQLScript(new Ptr(SCRIPT_TYPE, this.ptr.api, native));
    }
}

export class DashQLCatalogSnapshotReader {
    public catalogReader: buffers.catalog.FlatCatalog;
    nameDictionary: (string | null)[];

    /// Construct a snapshot reader with a name dictionary
    constructor(catalog: buffers.catalog.FlatCatalog, nameDictionary: (string | null)[]) {
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

export class DashQLCatalogSnapshot {
    public ptr: FlatBufferPtr<buffers.catalog.FlatCatalog>;
    nameDictionary: (string | null)[];

    constructor(snapshot: FlatBufferPtr<buffers.catalog.FlatCatalog>) {
        this.ptr = snapshot;
        this.nameDictionary = [];
    }
    /// Delete a snapshot
    public destroy() {
        this.ptr.destroy();
    }
    /// Read a snapshot
    public read(): DashQLCatalogSnapshotReader {
        const reader = this.ptr.read();
        return new DashQLCatalogSnapshotReader(reader, this.nameDictionary);
    }
}

function assertUint32(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${name} must be a uint32`);
    }
}

export class DashQLCatalog {
    public readonly ptr: Ptr<typeof CATALOG_TYPE, NativeCatalog>;
    public snapshot: DashQLCatalogSnapshot | null;

    public constructor(ptr: Ptr<typeof CATALOG_TYPE, NativeCatalog>) {
        this.ptr = ptr;
        this.snapshot = null;
    }
    /// Delete the catalog
    public destroy() {
        this.deleteSnapshot();
        this.ptr.destroy();
    }
    /// Delete the snapshot if there is one
    protected deleteSnapshot() {
        if (this.snapshot != null) {
            this.snapshot.destroy();
            this.snapshot = null;
        }
    }
    /// Reset a catalog
    public clear(): void {
        this.deleteSnapshot();
        this.ptr.assertNotNull().clear();
    }
    public allocateEntryId(): number {
        return this.ptr.assertNotNull().allocateEntryId();
    }
    public replaceDescriptor(catalogEntryId: number, rank: number, descriptor: Uint8Array): void {
        const catalog = this.ptr.assertNotNull();
        assertUint32(catalogEntryId, 'catalogEntryId');
        assertUint32(rank, 'rank');
        catalog.replaceDescriptor(catalogEntryId, rank, descriptor);
        this.deleteSnapshot();
    }
    public dropDescriptor(id: number): void {
        assertUint32(id, 'catalogEntryId');
        this.ptr.assertNotNull().dropDescriptor(id);
        this.deleteSnapshot();
    }
    /// Contains an entry id?
    public containsEntryId(entryId: number): boolean {
        return this.ptr.assertNotNull().containsEntryId(entryId);
    }
    /// Describe catalog entries
    public describeEntries(): FlatBufferPtr<buffers.catalog.CatalogEntries> {
        const bytes = this.ptr.assertNotNull().describeEntries();
        return new FlatBufferPtr(CATALOG_ENTRIES_TYPE, this.ptr.api, bytes, () => new buffers.catalog.CatalogEntries());
    }
    /// Describe the catalog entries of an entry
    public describeEntriesOf(id: number): FlatBufferPtr<buffers.catalog.CatalogEntries> {
        const bytes = this.ptr.assertNotNull().describeEntriesOf(id);
        if (bytes == null) {
            throw new Error(`unknown catalog entry: ${id}`);
        }
        return new FlatBufferPtr(CATALOG_ENTRIES_TYPE, this.ptr.api, bytes, () => new buffers.catalog.CatalogEntries());
    }
    /// Export a catalog snapshot
    public createSnapshot(): DashQLCatalogSnapshot {
        if (this.snapshot != null) {
            return this.snapshot;
        }
        const bytes = this.ptr.assertNotNull().flatten();
        this.snapshot = new DashQLCatalogSnapshot(
            new FlatBufferPtr(FLAT_CATALOG_TYPE, this.ptr.api, bytes, () => new buffers.catalog.FlatCatalog()),
        );
        return this.snapshot;
    }
    /// Add a script in the registry (throws exception on error)
    public loadScript(script: DashQLScript, rank: number) {
        this.deleteSnapshot();
        this.ptr.assertNotNull().loadScript(script.ptr.assertNotNull(), rank);
    }
    /// Atomically add or replace ranked scripts in the catalog.
    public loadScripts(scripts: ReadonlyArray<readonly [DashQLScript, number]>): void {
        if (scripts.length === 0) {
            return;
        }
        const catalog = this.ptr.assertNotNull();
        const natives = scripts.map(([script, rank]) => [script.ptr.assertNotNull(), rank] as const);
        const batch = new this.ptr.api.bindings.ScriptBatch();
        try {
            for (const [script, rank] of natives) {
                batch.add(script, rank);
            }
            catalog.loadScripts(batch);
            this.deleteSnapshot();
        } finally {
            batch.free();
        }
    }
    /// Drop a script from the registry
    public dropScript(script: DashQLScript) {
        this.deleteSnapshot();
        this.ptr.assertNotNull().dropScript(script.ptr.assertNotNull());
    }
    /// Get the catalog statistics.
    public getStatistics(): FlatBufferPtr<buffers.catalog.CatalogStatistics, buffers.catalog.CatalogStatisticsT> {
        const bytes = this.ptr.assertNotNull().statistics();
        return new FlatBufferPtr(CATALOG_STATISTICS_TYPE, this.ptr.api, bytes, () => new buffers.catalog.CatalogStatistics());
    }
}

export interface DashQLQueryGraphLayoutConfig {
    boardWidth: number;
    boardHeight: number;
    cellWidth: number;
    cellHeight: number;
    tableWidth: number;
    tableHeight: number;
}

export namespace ExternalObjectID {
    export type Value = bigint;

    /// Create the external id
    export function create(context: number, value: number): bigint {
        if (context == 0xffffffff) {
            throw new Error('context id 0xFFFFFFFF is reserved');
        }
        return (BigInt(context) << 32n) | BigInt(value);
    }
    /// Get the context id
    export function getOrigin(value: Value): number {
        return Number(value >> 32n);
    }
    /// Mask index
    export function getObject(value: Value): number {
        return Number(value & 0xffffffffn);
    }
    /// Is a null id?
    export function isNull(value: Value): boolean {
        return ExternalObjectID.getObject(value) == 0xffffffff;
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

export class DashQLPlanViewModel {
    public readonly ptr: Ptr<typeof PLAN_VIEW_MODEL_TYPE, NativePlanViewModel>;
    public layout: buffers.view.PlanLayoutConfigT;
    public buffer: FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> | null;

    public constructor(ptr: Ptr<typeof PLAN_VIEW_MODEL_TYPE, NativePlanViewModel>, layout: buffers.view.PlanLayoutConfigT) {
        this.ptr = ptr;
        this.layout = layout;
        this.reconfigure(layout);
        this.buffer = null;
    }
    /// Delete the plan view model
    public destroy() {
        this.ptr.destroy();
        this.buffer?.destroy();
    }
    /// Reconfigure the plan view model
    public reconfigure(config: buffers.view.PlanLayoutConfigT) {
        this.layout = config;
        this.ptr.assertNotNull().configure(
            this.layout.levelHeight,
            this.layout.nodeHeight,
            this.layout.nodeMarginHorizontal,
            this.layout.nodePaddingLeft,
            this.layout.nodePaddingRight,
            this.layout.iconWidth,
            this.layout.iconMarginRight,
            this.layout.maxLabelChars,
            this.layout.widthPerLabelChar,
            this.layout.nodeMinWidth,
        );
    }
    /// Pack the view model as FlatBuffer
    public pack(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        const bytes = this.ptr.assertNotNull().pack();
        this.buffer?.destroy();
        this.buffer = new FlatBufferPtr(FLAT_PLAN_VIEW_MODEL_TYPE, this.ptr.api, bytes, () => new buffers.view.PlanViewModel());
        return this.buffer;
    }
    /// Reset a Hyper plan
    public reset(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        this.ptr.assertNotNull().reset();
        return this.pack();
    }
    /// Reset the execution state of a Hyper plan
    public resetExecution(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        this.ptr.assertNotNull().resetExecution();
        return this.pack();
    }
    /// Load a Hyper plan
    public loadHyperPlan(plan: string): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        this.ptr.assertNotNull().loadHyperPlan(this.ptr.api.encoder.encode(plan));
        return this.pack();
    }
}
