import * as buffers from './buffers.js';
import * as flatbuffers from 'flatbuffers';

import { VariantKind } from './variant.js';
import { decodeBatchResult, encodeBatchRequest } from './batch.js';
import type { BatchRequest, BatchResult } from './batch.js';

// Emscripten module interface (what the generated JS provides)
export interface EmscriptenModule {
    // Memory views (Emscripten provides these automatically)
    HEAP8: Int8Array;
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    HEAPU16: Uint16Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    HEAPF32: Float32Array;
    HEAPF64: Float64Array;

    memory?: WebAssembly.Memory;

    // Stack manipulation functions (for stack allocation)
    stackSave: () => number;
    stackAlloc: (size: number) => number;
    stackRestore: (ptr: number) => void;

    // All C functions exported with underscore prefix
    _dashql_malloc: (length: number) => number;
    _dashql_free: (ptr: number) => void;
    _dashql_delete_owner: (owner_ptr: number, owner_deleter: number) => void;
    _dashql_process_batch: (result: number, request: number, requestLength: number) => void;
    _dashql_script_execution_new: (result: number, session: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean) => void;
    _dashql_script_execution_start: (result: number, ptr: number) => void;
    _dashql_script_execution_resume: (result: number, ptr: number, statementResult: number, statementResultLength: number) => void;
    _dashql_script_execution_cancel: (result: number, ptr: number) => void;
    _dashql_script_session_new: (result: number, catalog: number, offsetUnit: number) => void;
    _dashql_script_session_destroy: (ptr: number) => void;
    _dashql_script_session_get_catalog_entry_id: (ptr: number) => number;
    _dashql_script_session_get_text: (result: number, ptr: number) => void;
    _dashql_script_session_get_document_revision: (ptr: number) => bigint;
    _dashql_script_session_get_state_revision: (ptr: number) => bigint;
    _dashql_script_session_get_catalog_revision: (ptr: number) => bigint;
    _dashql_script_session_replace_text: (result: number, ptr: number, expectedDocumentRevision: bigint, text: number, textLength: number) => void;
    _dashql_script_session_apply: (result: number, ptr: number, event: number, eventLength: number) => void;
    _dashql_script_session_set_primary_cursor: (result: number, ptr: number, expectedDocumentRevision: bigint, offset: bigint) => void;
    _dashql_script_session_analyze: (result: number, ptr: number) => void;
    _dashql_script_session_complete_at_cursor: (result: number, ptr: number, limit: number, keywordCase: number) => void;
    _dashql_script_session_compile_query: (result: number, ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, allowExtensions: boolean, parseIfOutdated: boolean) => void;
    _dashql_script_session_format: (result: number, ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean, keywordCase: number, parseIfOutdated: boolean, catalog: number) => void;
    _dashql_script_session_rewrite_dashboard: (result: number, ptr: number, row: number, column: number, width: number, height: number, parseIfOutdated: boolean) => void;
    _dashql_script_session_is_fully_formattable: (ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean, parseIfOutdated: boolean) => number;
    _dashql_script_session_compute_diff: (result: number, ptr: number, target: number) => void;
    _dashql_script_session_load_into_catalog: (ptr: number, rank: number) => void;
    _dashql_script_session_drop_from_catalog: (ptr: number) => void;
    _dashql_script_new: (result: number, catalog: number) => void;
    _dashql_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    _dashql_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    _dashql_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    _dashql_script_replace_text: (ptr: number, text: number, textLength: number) => void;
    _dashql_script_to_string: (result: number, ptr: number, offset: number, length: number) => void;
    _dashql_script_get_statement_text: (result: number, ptr: number, parse_if_outdated: boolean) => void;
    _dashql_script_compile_query: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, allow_extensions: boolean, parse_if_outdated: boolean) => void;
    _dashql_script_parse: (ptr: number) => void;
    _dashql_script_analyze: (ptr: number, parse_if_outdated: boolean) => void;
    _dashql_script_move_cursor: (result: number, ptr: number, offset: number) => void;
    _dashql_script_complete_at_cursor: (result: number, ptr: number, limit: number, keywordCase: number) => void;
    _dashql_script_get_catalog_entry_id: (ptr: number) => number;
    _dashql_script_get_parsed: (result: number, ptr: number) => void;
    _dashql_script_get_analyzed: (result: number, ptr: number) => void;
    _dashql_script_compute_diff: (result: number, source: number, target: number) => void;
    _dashql_script_get_statistics: (result: number, ptr: number) => void;
    _dashql_script_format: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, keywordCase: number, parse_if_outdated: boolean, catalog: number) => void;
    _dashql_script_is_fully_formattable: (ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, parse_if_outdated: boolean) => number;
    _dashql_script_get_unformattable_nodes: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, parse_if_outdated: boolean) => void;
    _dashql_catalog_new: (result: number) => void;
    _dashql_catalog_clear: (catalog_ptr: number) => void;
    _dashql_catalog_allocate_entry_id: (catalog: number) => number;
    _dashql_catalog_replace_descriptor: (catalog: number, id: number, rank: number, bytes: number, length: number) => void;
    _dashql_catalog_drop_descriptor: (catalog: number, id: number) => void;
    _dashql_catalog_contains_entry_id: (catalog_ptr: number, external_id: number) => boolean;
    _dashql_catalog_describe_entries: (result: number, catalog_ptr: number) => void;
    _dashql_catalog_describe_entries_of: (result: number, catalog_ptr: number, external_id: number) => void;
    _dashql_catalog_flatten: (result: number, catalog_ptr: number) => void;
    _dashql_parse_vegalite_to_visualize: (result: number, json: number, json_length: number) => void;
    _dashql_catalog_load_script: (catalog_ptr: number, script_ptr: number, rank: number) => void;
    _dashql_catalog_load_scripts: (catalog_ptr: number, script_ptrs: number, ranks: number, script_count: number) => void;
    _dashql_catalog_drop_script: (catalog_ptr: number, script_ptr: number) => void;
    _dashql_catalog_get_statistics: (result: number, ptr: number) => void;
    _dashql_plan_view_model_new: (result: number) => void;
    _dashql_plan_view_model_configure: (viewmodel_ptr: number, levelHeight: number, nodeHeight: number, nodeMarginHorizontal: number, nodePaddingLeft: number, nodePaddingRight: number, iconWidth: number, iconMarginRight: number, maxLabelChars: number, widthPerLabelChar: number, minNodeWidth: number) => void;
    _dashql_plan_view_model_load_hyper_plan: (viewmodel_ptr: number, text: number, text_length: number) => void;
    _dashql_plan_view_model_reset: (viewmodel_ptr: number) => void;
    _dashql_plan_view_model_reset_execution: (viewmodel_ptr: number) => void;
    _dashql_plan_view_model_pack: (result: number, viewmodel_ptr: number) => void;
}

export interface DashQLModuleOptions {
    instantiateWasm?: InstantiateWasmCallback;
    wasmBinary?: Uint8Array;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    locateFile?: (path: string, prefix: string) => string;
}

// Our cleaned-up API interface (without underscores)
interface DashQLModuleExports {
    dashql_malloc: (length: number) => number;
    dashql_free: (ptr: number) => void;
    dashql_delete_owner: (owner_ptr: number, owner_deleter: number) => void;
    dashql_process_batch: (result: number, request: number, requestLength: number) => void;

    dashql_script_execution_new: (result: number, session: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean) => void;
    dashql_script_execution_start: (result: number, ptr: number) => void;
    dashql_script_execution_resume: (result: number, ptr: number, statementResult: number, statementResultLength: number) => void;
    dashql_script_execution_cancel: (result: number, ptr: number) => void;

    dashql_script_session_new: (result: number, catalog: number, offsetUnit: number) => void;
    dashql_script_session_destroy: (ptr: number) => void;
    dashql_script_session_get_catalog_entry_id: (ptr: number) => number;
    dashql_script_session_get_text: (result: number, ptr: number) => void;
    dashql_script_session_get_document_revision: (ptr: number) => bigint;
    dashql_script_session_get_state_revision: (ptr: number) => bigint;
    dashql_script_session_get_catalog_revision: (ptr: number) => bigint;
    dashql_script_session_replace_text: (result: number, ptr: number, expectedDocumentRevision: bigint, text: number, textLength: number) => void;
    dashql_script_session_apply: (result: number, ptr: number, event: number, eventLength: number) => void;
    dashql_script_session_set_primary_cursor: (result: number, ptr: number, expectedDocumentRevision: bigint, offset: bigint) => void;
    dashql_script_session_analyze: (result: number, ptr: number) => void;
    dashql_script_session_complete_at_cursor: (result: number, ptr: number, limit: number, keywordCase: number) => void;
    dashql_script_session_compile_query: (result: number, ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, allowExtensions: boolean, parseIfOutdated: boolean) => void;
    dashql_script_session_format: (result: number, ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean, keywordCase: number, parseIfOutdated: boolean, catalog: number) => void;
    dashql_script_session_rewrite_dashboard: (result: number, ptr: number, row: number, column: number, width: number, height: number, parseIfOutdated: boolean) => void;
    dashql_script_session_is_fully_formattable: (ptr: number, dialect: number, mode: number, maxWidth: number, indentationWidth: number, debugMode: boolean, parseIfOutdated: boolean) => number;
    dashql_script_session_compute_diff: (result: number, ptr: number, target: number) => void;
    dashql_script_session_load_into_catalog: (ptr: number, rank: number) => void;
    dashql_script_session_drop_from_catalog: (ptr: number) => void;

    dashql_script_new: (result: number, catalog: number) => void;
    dashql_script_insert_text_at: (ptr: number, offset: number, text: number, textLength: number) => void;
    dashql_script_insert_char_at: (ptr: number, offset: number, unicode: number) => void;
    dashql_script_erase_text_range: (ptr: number, offset: number, length: number) => void;
    dashql_script_replace_text: (ptr: number, text: number, textLength: number) => void;
    dashql_script_to_string: (result: number, ptr: number, offset: number, length: number) => void;
    dashql_script_get_statement_text: (result: number, ptr: number, parse_if_outdated: boolean) => void;
    dashql_script_compile_query: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, allow_extensions: boolean, parse_if_outdated: boolean) => void;
    dashql_script_parse: (ptr: number) => void;
    dashql_script_analyze: (ptr: number, parse_if_outdated: boolean) => void;
    dashql_script_move_cursor: (result: number, ptr: number, offset: number) => void;
    dashql_script_complete_at_cursor: (result: number, ptr: number, limit: number, keywordCase: number) => void;
    dashql_script_get_catalog_entry_id: (ptr: number) => number;
    dashql_script_get_parsed: (result: number, ptr: number) => void;
    dashql_script_get_analyzed: (result: number, ptr: number) => void;
    dashql_script_compute_diff: (result: number, source: number, target: number) => void;
    dashql_script_get_statistics: (result: number, ptr: number) => void;
    dashql_script_format: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, keywordCase: number, parse_if_outdated: boolean, catalog: number) => void;
    dashql_script_is_fully_formattable: (ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, parse_if_outdated: boolean) => number;
    dashql_script_get_unformattable_nodes: (result: number, ptr: number, dialect: number, mode: number, max_width: number, indentation_width: number, debug_mode: boolean, parse_if_outdated: boolean) => void;

    dashql_catalog_new: (result: number) => void;
    dashql_catalog_clear: (catalog_ptr: number) => void;
    dashql_catalog_allocate_entry_id: (catalog: number) => number;
    dashql_catalog_replace_descriptor: (catalog: number, id: number, rank: number, bytes: number, length: number) => void;
    dashql_catalog_drop_descriptor: (catalog: number, id: number) => void;
    dashql_catalog_contains_entry_id: (catalog_ptr: number, external_id: number) => boolean;
    dashql_catalog_describe_entries: (result: number, catalog_ptr: number) => void;
    dashql_catalog_describe_entries_of: (result: number, catalog_ptr: number, external_id: number) => void;
    dashql_catalog_flatten: (result: number, catalog_ptr: number) => void;
    dashql_parse_vegalite_to_visualize: (result: number, json: number, json_length: number) => void;
    dashql_catalog_load_script: (catalog_ptr: number, script_ptr: number, rank: number) => void;
    dashql_catalog_load_scripts: (catalog_ptr: number, script_ptrs: number, ranks: number, script_count: number) => void;
    dashql_catalog_drop_script: (catalog_ptr: number, script_ptr: number) => void;
    dashql_catalog_get_statistics: (result: number, ptr: number) => void;

    dashql_plan_view_model_new: (result: number) => void;
    dashql_plan_view_model_configure: (viewmodel_ptr: number, levelHeight: number, nodeHeight: number, nodeMarginHorizontal: number, nodePaddingLeft: number, nodePaddingRight: number, iconWidth: number, iconMarginRight: number, maxLabelChars: number, widthPerLabelChar: number, minNodeWidth: number) => void;
    dashql_plan_view_model_load_hyper_plan: (viewmodel_ptr: number, text: number, text_length: number) => void;
    dashql_plan_view_model_reset: (viewmodel_ptr: number) => void;
    dashql_plan_view_model_reset_execution: (viewmodel_ptr: number) => void;
    dashql_plan_view_model_pack: (result: number, viewmodel_ptr: number) => void;
}

type InstantiateWasmCallback = (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
) => WebAssembly.Exports | Promise<WebAssembly.Exports>;

import createDashQLModule from './wasm/dashql_core.js';

interface FlatBufferObject<T, O> {
    __init(i: number, bb: flatbuffers.ByteBuffer): T;
    unpack(): O;
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
const FLAT_CATALOG_TYPE = Symbol('FLAT_CATALOG_TYPE');
const FLAT_PLAN_VIEW_MODEL_TYPE = Symbol('FLAT_PLAN_VIEW_MODEL_TYPE');
const PARSED_SCRIPT_TYPE = Symbol('PARSED_SCRIPT_TYPE');
const PLAN_VIEW_MODEL_TYPE = Symbol('PLAN_VIEW_MODEL_TYPE');
const SCRIPT_STATISTICS_TYPE = Symbol('SCRIPT_STATISTICS_TYPE');
const SCRIPT_TYPE = Symbol('SCRIPT_TYPE');
const TEMPORARY = Symbol('TEMPORARY');

export type DashQLRegisteredMemory =
    | VariantKind<typeof ANALYZED_SCRIPT_TYPE, FlatBufferPtr<buffers.analyzer.AnalyzedScript>>
    | VariantKind<typeof CATALOG_ENTRIES_TYPE, FlatBufferPtr<buffers.catalog.CatalogEntries>>
    | VariantKind<typeof CATALOG_STATISTICS_TYPE, FlatBufferPtr<buffers.catalog.CatalogStatistics>>
    | VariantKind<typeof CATALOG_TYPE, Ptr<typeof CATALOG_TYPE>>
    | VariantKind<typeof COMPLETION_TYPE, FlatBufferPtr<buffers.completion.Completion>>
    | VariantKind<typeof CURSOR_TYPE, FlatBufferPtr<buffers.cursor.ScriptCursor>>
    | VariantKind<typeof SCRIPT_SESSION_TYPE, Ptr<typeof SCRIPT_SESSION_TYPE>>
    | VariantKind<typeof EDITOR_UPDATE_TYPE, FlatBufferPtr<buffers.editor.EditorUpdate>>
    | VariantKind<typeof SCRIPT_DIFF_TYPE, FlatBufferPtr<buffers.diff.ScriptDiff>>
    | VariantKind<typeof SCRIPT_COMPILATION_TYPE, FlatBufferPtr<buffers.execution.ScriptCompilationResult>>
    | VariantKind<typeof SCRIPT_EXECUTION_TYPE, Ptr<typeof SCRIPT_EXECUTION_TYPE>>
    | VariantKind<typeof SCRIPT_EXECUTION_UPDATE_TYPE, FlatBufferPtr<buffers.execution.ScriptExecutionUpdate>>
    | VariantKind<typeof FLAT_CATALOG_TYPE, FlatBufferPtr<buffers.catalog.FlatCatalog>>
    | VariantKind<typeof FLAT_PLAN_VIEW_MODEL_TYPE, FlatBufferPtr<buffers.view.PlanViewModel>>
    | VariantKind<typeof PARSED_SCRIPT_TYPE, FlatBufferPtr<buffers.parser.ParsedScript>>
    | VariantKind<typeof PLAN_VIEW_MODEL_TYPE, Ptr<typeof PLAN_VIEW_MODEL_TYPE>>
    | VariantKind<typeof SCRIPT_STATISTICS_TYPE, FlatBufferPtr<buffers.statistics.ScriptStatistics>>
    | VariantKind<typeof SCRIPT_TYPE, Ptr<typeof SCRIPT_TYPE>>
    | VariantKind<typeof TEMPORARY, FlatBufferPtr<any>>
    ;

export interface DashQLRegisteredMemoryEntry {
    value: DashQLRegisteredMemory;
}

export class DashQL {
    encoder: TextEncoder;
    decoder: TextDecoder;
    module: EmscriptenModule;
    memory: WebAssembly.Memory;
    instanceExports: DashQLModuleExports;
    nextScriptId: number;
    registeredMemory: Map<number, DashQLRegisteredMemoryEntry>;

    public constructor(module: EmscriptenModule) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.module = module;
        this.memory = module.memory ?? ({ buffer: module.HEAPU8.buffer } as WebAssembly.Memory);
        this.nextScriptId = 1;
        this.registeredMemory = new Map();

        // Wrap all Emscripten exports, removing the leading underscore
        this.instanceExports = {
            dashql_malloc: module._dashql_malloc,
            dashql_free: module._dashql_free,
            dashql_delete_owner: module._dashql_delete_owner,
            dashql_process_batch: module._dashql_process_batch,
            dashql_script_execution_new: module._dashql_script_execution_new,
            dashql_script_execution_start: module._dashql_script_execution_start,
            dashql_script_execution_resume: module._dashql_script_execution_resume,
            dashql_script_execution_cancel: module._dashql_script_execution_cancel,
            dashql_script_session_new: module._dashql_script_session_new,
            dashql_script_session_destroy: module._dashql_script_session_destroy,
            dashql_script_session_get_catalog_entry_id: module._dashql_script_session_get_catalog_entry_id,
            dashql_script_session_get_text: module._dashql_script_session_get_text,
            dashql_script_session_get_document_revision: module._dashql_script_session_get_document_revision,
            dashql_script_session_get_state_revision: module._dashql_script_session_get_state_revision,
            dashql_script_session_get_catalog_revision: module._dashql_script_session_get_catalog_revision,
            dashql_script_session_replace_text: module._dashql_script_session_replace_text,
            dashql_script_session_apply: module._dashql_script_session_apply,
            dashql_script_session_set_primary_cursor: module._dashql_script_session_set_primary_cursor,
            dashql_script_session_analyze: module._dashql_script_session_analyze,
            dashql_script_session_complete_at_cursor: module._dashql_script_session_complete_at_cursor,
            dashql_script_session_compile_query: module._dashql_script_session_compile_query,
            dashql_script_session_format: module._dashql_script_session_format,
            dashql_script_session_rewrite_dashboard: module._dashql_script_session_rewrite_dashboard,
            dashql_script_session_is_fully_formattable: module._dashql_script_session_is_fully_formattable,
            dashql_script_session_compute_diff: module._dashql_script_session_compute_diff,
            dashql_script_session_load_into_catalog: module._dashql_script_session_load_into_catalog,
            dashql_script_session_drop_from_catalog: module._dashql_script_session_drop_from_catalog,
            dashql_script_new: module._dashql_script_new,
            dashql_catalog_clear: module._dashql_catalog_clear,
            dashql_script_insert_text_at: module._dashql_script_insert_text_at,
            dashql_script_insert_char_at: module._dashql_script_insert_char_at,
            dashql_script_erase_text_range: module._dashql_script_erase_text_range,
            dashql_script_replace_text: module._dashql_script_replace_text,
            dashql_script_to_string: module._dashql_script_to_string,
            dashql_script_get_statement_text: module._dashql_script_get_statement_text,
            dashql_script_compile_query: module._dashql_script_compile_query,
            dashql_script_parse: module._dashql_script_parse,
            dashql_script_analyze: module._dashql_script_analyze,
            dashql_script_get_statistics: module._dashql_script_get_statistics,
            dashql_script_get_catalog_entry_id: module._dashql_script_get_catalog_entry_id,
            dashql_script_get_parsed: module._dashql_script_get_parsed,
            dashql_script_get_analyzed: module._dashql_script_get_analyzed,
            dashql_script_compute_diff: module._dashql_script_compute_diff,
            dashql_script_move_cursor: module._dashql_script_move_cursor,
            dashql_script_complete_at_cursor: module._dashql_script_complete_at_cursor,
            dashql_script_format: module._dashql_script_format,
            dashql_script_is_fully_formattable: module._dashql_script_is_fully_formattable,
            dashql_script_get_unformattable_nodes: module._dashql_script_get_unformattable_nodes,
            dashql_catalog_new: module._dashql_catalog_new,
            dashql_catalog_allocate_entry_id: module._dashql_catalog_allocate_entry_id,
            dashql_catalog_replace_descriptor: module._dashql_catalog_replace_descriptor,
            dashql_catalog_drop_descriptor: module._dashql_catalog_drop_descriptor,
            dashql_catalog_contains_entry_id: module._dashql_catalog_contains_entry_id,
            dashql_catalog_describe_entries: module._dashql_catalog_describe_entries,
            dashql_catalog_describe_entries_of: module._dashql_catalog_describe_entries_of,
            dashql_catalog_flatten: module._dashql_catalog_flatten,
            dashql_parse_vegalite_to_visualize: module._dashql_parse_vegalite_to_visualize,
            dashql_catalog_load_script: module._dashql_catalog_load_script,
            dashql_catalog_load_scripts: module._dashql_catalog_load_scripts,
            dashql_catalog_drop_script: module._dashql_catalog_drop_script,
            dashql_catalog_get_statistics: module._dashql_catalog_get_statistics,
            dashql_plan_view_model_new: module._dashql_plan_view_model_new,
            dashql_plan_view_model_configure: module._dashql_plan_view_model_configure,
            dashql_plan_view_model_load_hyper_plan: module._dashql_plan_view_model_load_hyper_plan,
            dashql_plan_view_model_reset: module._dashql_plan_view_model_reset,
            dashql_plan_view_model_reset_execution: module._dashql_plan_view_model_reset_execution,
            dashql_plan_view_model_pack: module._dashql_plan_view_model_pack,
        };
    }

    public static async create(options?: DashQLModuleOptions): Promise<DashQL> {
        return new DashQL(await DashQL.createModule(options));
    }

    private static async createModule(options?: DashQLModuleOptions): Promise<EmscriptenModule> {
        // Call the Emscripten-generated factory function
        // All WASI stubs and initialization are handled automatically!
        return await createDashQLModule({
            // Optional hooks for console output
            print: options?.print || ((text: string) => console.log(text)),
            printErr: options?.printErr || ((text: string) => console.error(text)),

            // Optional: preloaded WASM binary for faster instantiation (used in tests)
            wasmBinary: options?.wasmBinary,

            // Optional: intercept WASM instantiation for progress tracking
            instantiateWasm: options?.instantiateWasm,

            locateFile: options?.locateFile,
        });

    }

    public copyString(text: string): [number, number] {
        // Empty strings are passed as null pointer
        if (text.length == 0) {
            return [0, 0];
        }
        // To convert a JavaScript string s, the output space needed for full conversion is never less
        // than s.length bytes and never greater than s.length * 3 bytes.
        const bufferSize = text.length * 3 + 1;
        const textBegin = this.instanceExports.dashql_malloc(bufferSize);
        // Allocation failed?
        if (textBegin == 0) {
            throw new Error(`failed to allocate a string of size ${text.length}`);
        }
        const encodedBuffer = new Uint8Array(bufferSize);
        const textEncoded = this.encoder.encodeInto(text, encodedBuffer);
        if (textEncoded.written == undefined || textEncoded.written == 0) {
            this.instanceExports.dashql_free(textBegin);
            throw new Error(`failed to encode a string of size ${text.length}`);
        }
        const textBuffer = this.module.HEAPU8.subarray(textBegin, textBegin + bufferSize);
        textBuffer.set(encodedBuffer.subarray(0, textEncoded.written));
        // Write zero-terminator to be safe
        textBuffer[textEncoded.written] = 0;
        return [textBegin, textEncoded.written];
    }

    public copyBuffer(src: Uint8Array): [number, number] {
        if (src.length == 0) {
            return [0, 0];
        }
        const ptr = this.instanceExports.dashql_malloc(src.length);
        if (ptr == 0) {
            throw new Error(`failed to allocate a buffer of size ${src.length}`);
        }
        try {
            const dst = this.module.HEAPU8.subarray(ptr, ptr + src.length);
            dst.set(src);
            return [ptr, src.length];
        } catch (error) {
            this.instanceExports.dashql_free(ptr);
            throw error;
        }
    }

    // Stack-allocated FFIResult pattern
    // FFIResult layout on wasm32: data_length(4), data_ptr(4), owner_ptr(4), owner_deleter(4) = 16 bytes
    public callSRet(fn: (resultPtr: number) => void): { data_length: number; data_ptr: number; owner_ptr: number; owner_deleter: number } {
        const sp = this.module.stackSave();
        try {
            // Allocate 16 bytes for FFIResult on stack
            const resultPtr = this.module.stackAlloc(16);
            this.module.HEAPU32.fill(0, resultPtr / 4, resultPtr / 4 + 4);

            // Call the C function with the stack address
            try {
                fn(resultPtr);
            } catch (error) {
                const heap = this.module.HEAPU32;
                this.instanceExports.dashql_delete_owner(heap[resultPtr / 4 + 2], heap[resultPtr / 4 + 3]);
                throw error;
            }

            // Read the fields from the stack
            const resultPtrU32 = resultPtr / 4;
            const heapU32 = this.module.HEAPU32;
            return {
                data_length: heapU32[resultPtrU32 + 0],
                data_ptr: heapU32[resultPtrU32 + 1],
                owner_ptr: heapU32[resultPtrU32 + 2],
                owner_deleter: heapU32[resultPtrU32 + 3],
            };
        } finally {
            // Restore stack pointer
            this.module.stackRestore(sp);
        }
    }

    public registerMemory(ptr: DashQLRegisteredMemory) {
        let key = ptr.value.resultPtr;
        if (key == null) {
            return;
        }
        // If this address is already registered, it means WASM reused the address.
        // The old Ptr is now stale - mark it as destroyed to prevent double-free
        if (this.registeredMemory.has(key)) {
            const oldEntry = this.registeredMemory.get(key)!;
            oldEntry.value.value.resultPtr = null;
        }
        this.registeredMemory.set(key!, { value: ptr });
    }
    public unregisterMemory(resultPtr: number) {
        this.registeredMemory.delete(resultPtr);
    }
    /// Destroy all registered memory.
    /// This is unsafe because it will just release all memory while javascript might still reference into the heap.
    /// Test-only teardown helper.
    ///
    /// Objects are freed in reverse registration order (LIFO, like RAII) because
    /// some destructors reach into objects registered earlier: e.g. Script::~Script
    /// calls catalog.DropScript(*this). A catalog is typically created (and thus
    /// registered) before the scripts loaded into it, so freeing in registration
    /// order would destroy the catalog first and leave ~Script touching freed
    /// memory, corrupting the WASM allocator. Reverse order destroys the scripts
    /// before the catalog they depend on.
    public resetUnsafe() {
        const entries = Array.from(this.registeredMemory.entries());
        for (let i: number = entries.length - 1; i >= 0; --i) {
            const inner = entries[i][1].value;
            try {
                inner.value.destroy();
            } catch (e) {
                // Ignore errors during cleanup - object may have already been freed
            }
        }
        this.registeredMemory = new Map();
    }

    public processBatch(request: BatchRequest): BatchResult {
        const [inputPtr, inputLength] = this.copyBuffer(encodeBatchRequest(request));
        try {
            const result = this.callSRet(resultPtr =>
                this.instanceExports.dashql_process_batch(resultPtr, inputPtr, inputLength)
            );
            try {
                return decodeBatchResult(this.module.HEAPU8.subarray(
                    result.data_ptr, result.data_ptr + result.data_length,
                ));
            } finally {
                this.instanceExports.dashql_delete_owner(result.owner_ptr, result.owner_deleter);
            }
        } finally {
            this.instanceExports.dashql_free(inputPtr);
        }
    }

    public createScript(
        catalog: DashQLCatalog,
        databaseName: string | null = null,
        schemaName: string | null = null,
    ): DashQLScript {
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
                this.instanceExports.dashql_free(databaseNamePtr);
                throw e;
            }
        }
        const catalogPtr = catalog?.ptr?.assertNotNull() ?? 0;
        const scriptPtr = this.callSRetPtr(SCRIPT_TYPE, (resultPtr) =>
            this.instanceExports.dashql_script_new(resultPtr, catalogPtr)
        );
        const script = new DashQLScript(scriptPtr);
        this.registerMemory({ type: SCRIPT_TYPE, value: script.ptr });
        return script;
    }

    public createCatalog(): DashQLCatalog {
        const ptr = this.callSRetPtr(CATALOG_TYPE, (resultPtr) =>
            this.instanceExports.dashql_catalog_new(resultPtr)
        );
        const catalog = new DashQLCatalog(ptr);
        this.registerMemory({ type: CATALOG_TYPE, value: catalog.ptr! });
        return catalog;
    }

    public createScriptSession(
        catalog: DashQLCatalog,
        offsetUnit = buffers.editor.EditorOffsetUnit.UTF16_CODE_UNITS,
    ): DashQLScriptSession {
        const catalogPtr = catalog.ptr.assertNotNull();
        const ptr = this.callSRetPtr(SCRIPT_SESSION_TYPE, (resultPtr) =>
            this.instanceExports.dashql_script_session_new(resultPtr, catalogPtr, offsetUnit)
        );
        const session = new DashQLScriptSession(ptr);
        this.registerMemory({ type: SCRIPT_SESSION_TYPE, value: session.ptr });
        return session;
    }

    public createPlanViewModel(layoutConfig: buffers.view.PlanLayoutConfigT): DashQLPlanViewModel {
        const ptr = this.callSRetPtr(PLAN_VIEW_MODEL_TYPE, (resultPtr) =>
            this.instanceExports.dashql_plan_view_model_new(resultPtr)
        );
        const viewModel = new DashQLPlanViewModel(ptr, layoutConfig);
        this.registerMemory({ type: PLAN_VIEW_MODEL_TYPE, value: viewModel.ptr! });
        return viewModel;
    }

    public readString(dataPtr: number, dataLength: number): string {
        const dataArray = new Uint8Array(this.module.HEAPU8.subarray(dataPtr, dataPtr + dataLength));
        return this.decoder.decode(dataArray);
    }

    public callSRetPtr<T extends symbol>(ptrType: T, fn: (resultPtr: number) => void) {
        const result = this.callSRet(fn);
        return new Ptr(ptrType, this, result.owner_ptr, result.owner_deleter);
    }

    public callSRetFlatBufPtr<T extends FlatBufferObject<T, O> = any, O = any>(sym: symbol, fn: (resultPtr: number) => void, factory: () => T) {
        const result = this.callSRet(fn);
        return new FlatBufferPtr<T>(sym, this, result.data_ptr, result.data_length, result.owner_ptr, result.owner_deleter, factory);
    }

    public readStringResult(fn: (resultPtr: number) => void): string {
        const result = this.callSRet(fn);
        const dataArray = new Uint8Array(
            this.module.HEAPU8.subarray(result.data_ptr, result.data_ptr + result.data_length),
        );
        const text = this.decoder.decode(dataArray);
        // Clean up the owner
        this.instanceExports.dashql_delete_owner(result.owner_ptr, result.owner_deleter);
        return text;
    }

    public readUint32ArrayResult(fn: (resultPtr: number) => void): number[] {
        const result = this.callSRet(fn);
        try {
            const begin = result.data_ptr / Uint32Array.BYTES_PER_ELEMENT;
            return Array.from(this.module.HEAPU32.subarray(
                begin,
                begin + result.data_length / Uint32Array.BYTES_PER_ELEMENT,
            ));
        } finally {
            this.instanceExports.dashql_delete_owner(result.owner_ptr, result.owner_deleter);
        }
    }

    /// Transcode a (constrained) Vega-Lite JSON spec into a VISUALIZE statement.
    /// Returns an empty string if the JSON is malformed. The source clause is derived from the
    /// spec's `data` member (see `ParseVegaLiteToVisualize` in `vegalite_parser.cc`).
    public parseVegaLiteToVisualize(vegaLiteJson: string): string {
        const [jsonBegin, jsonLength] = this.copyString(vegaLiteJson);
        return this.readStringResult((resultPtr) =>
            this.instanceExports.dashql_parse_vegalite_to_visualize(resultPtr, jsonBegin, jsonLength),
        );
    }
}

export const NULL_POINTER_EXCEPTION = new Error('tried to access a null pointer');

export class Ptr<T extends symbol> {
    /// The object type
    public readonly type: symbol;
    /// The DashQL api
    public readonly api: DashQL;
    /// The pointer
    public readonly ptr: number;
    /// Owner info for cleanup
    private ownerPtr: number | null;
    private ownerDeleter: number | null;
    /// Unique key for registration (use owner_ptr as key)
    resultPtr: number | null;

    public constructor(type: T, api: DashQL, ownerPtr: number, ownerDeleter: number) {
        this.type = type;
        this.api = api;
        this.ptr = ownerPtr;
        this.ownerPtr = ownerPtr;
        this.ownerDeleter = ownerDeleter;
        this.resultPtr = ownerPtr; // Use owner_ptr as the key for registration
    }
    /// Delete the object
    public destroy() {
        if (this.ownerPtr != null && this.ownerDeleter != null) {
            try {
                if (this.resultPtr != null) {
                    this.api.unregisterMemory(this.resultPtr);
                }
                this.api.instanceExports.dashql_delete_owner(this.ownerPtr, this.ownerDeleter);
            } catch (e) {
                // Memory may have been freed - this is OK during cleanup
            } finally {
                this.ownerPtr = null;
                this.ownerDeleter = null;
                this.resultPtr = null;
            }
        }
    }
    /// Make sure the pointer is not null
    public assertNotNull(): number {
        if (this.ownerPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.ptr;
    }
    /// Is null?
    public isNull(): boolean {
        return this.ownerPtr == null;
    }
    /// Get the object pointer
    public get(): number | null {
        return this.ptr;
    }
}

export class FlatBufferPtr<T extends FlatBufferObject<T, O>, O = any> {
    /// The object type
    public readonly type: symbol;
    /// The DashQL api
    public readonly api: DashQL;
    /// The data pointer
    dataPtr: number | null;
    /// The data length
    dataLength: number;
    /// Owner info for cleanup
    private ownerPtr: number | null;
    private ownerDeleter: number | null;
    /// Unique key for registration (use owner_ptr as key)
    resultPtr: number | null;
    /// The factory
    factory: () => T;

    public constructor(type: symbol, api: DashQL, dataPtr: number, dataLength: number, ownerPtr: number, ownerDeleter: number, factory: () => T) {
        this.type = type;
        this.api = api;
        this.dataPtr = dataPtr;
        this.dataLength = dataLength;
        this.ownerPtr = ownerPtr;
        this.ownerDeleter = ownerDeleter;
        this.resultPtr = ownerPtr; // Use owner_ptr as the key for registration
        this.factory = factory;
    }
    /// Delete the buffer
    public destroy(registered: boolean = true) {
        if (this.ownerPtr != null && this.ownerDeleter != null) {
            try {
                if (registered && this.resultPtr != null) {
                    this.api.unregisterMemory(this.resultPtr);
                }
                this.api.instanceExports.dashql_delete_owner(this.ownerPtr, this.ownerDeleter);
            } catch (e) {
                // Memory may have been freed - this is OK during cleanup
            } finally {
                this.ownerPtr = null;
                this.ownerDeleter = null;
                this.resultPtr = null;
            }
        }
    }
    /// Make sure the data ptr is not null
    public assertResultNotNull(): number {
        if (this.resultPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.resultPtr;
    }
    /// Make sure the data ptr is not null
    public assertDataNotNull(): number {
        if (this.dataPtr == null) {
            throw NULL_POINTER_EXCEPTION;
        }
        return this.dataPtr;
    }
    /// Get the data
    public get data(): Uint8Array {
        const begin = this.dataPtr ?? 0;
        return this.api.module.HEAPU8.subarray(begin, begin + this.dataLength);
    }
    /// Copy the data into a buffer
    public copy(): Uint8Array {
        const copy = new Uint8Array(new ArrayBuffer(this.data.byteLength));
        copy.set(this.data);
        return copy;
    }
    /// Equals a different flatbuffer ptr?
    public equals(other: FlatBufferPtr<T>): boolean {
        return this.resultPtr == other.resultPtr;
    }
    // Get the flatbuffer object
    // C.f. getRootAsAnalyzedScript
    public read(obj: T | null = null): T {
        obj = obj ?? this.factory();
        const bb = new flatbuffers.ByteBuffer(this.data);
        return obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    // Get the flatbuffer object, unpack it and destroy the memory
    public unpackAndDestroy(obj: T | null = null): O {
        obj = obj ?? this.factory();
        const bb = new flatbuffers.ByteBuffer(this.data);
        obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
        const out = obj.unpack();
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

export class DashQLScriptExecution {
    public readonly ptr: Ptr<typeof SCRIPT_EXECUTION_TYPE>;

    public constructor(ptr: Ptr<typeof SCRIPT_EXECUTION_TYPE>) {
        this.ptr = ptr;
    }

    public destroy(): void {
        this.ptr.destroy();
    }

    public start(): buffers.execution.ScriptExecutionUpdateT {
        return this.readOperation(resultPtr =>
            this.ptr.api.instanceExports.dashql_script_execution_start(resultPtr, this.ptr.assertNotNull())
        );
    }

    public resume(statementResult: buffers.execution.StatementResultT): buffers.execution.ScriptExecutionUpdateT {
        const builder = new flatbuffers.Builder();
        builder.finish(statementResult.pack(builder));
        const [inputPtr, inputLength] = this.ptr.api.copyBuffer(builder.asUint8Array());
        try {
            return this.readOperation(resultPtr =>
                this.ptr.api.instanceExports.dashql_script_execution_resume(
                    resultPtr,
                    this.ptr.assertNotNull(),
                    inputPtr,
                    inputLength,
                )
            );
        } finally {
            this.ptr.api.instanceExports.dashql_free(inputPtr);
        }
    }

    public cancel(): buffers.execution.ScriptExecutionUpdateT {
        return this.readOperation(resultPtr =>
            this.ptr.api.instanceExports.dashql_script_execution_cancel(resultPtr, this.ptr.assertNotNull())
        );
    }

    private readOperation(fn: (resultPtr: number) => void): buffers.execution.ScriptExecutionUpdateT {
        const result = this.ptr.api.callSRetFlatBufPtr<
            buffers.execution.ScriptExecutionUpdate,
            buffers.execution.ScriptExecutionUpdateT
        >(
            SCRIPT_EXECUTION_UPDATE_TYPE,
            fn,
            () => new buffers.execution.ScriptExecutionUpdate(),
        );
        this.ptr.api.registerMemory({ type: SCRIPT_EXECUTION_UPDATE_TYPE, value: result });
        return result.unpackAndDestroy();
    }
}

export class DashQLScriptSession {
    public readonly ptr: Ptr<typeof SCRIPT_SESSION_TYPE>;
    public readonly catalog_entry_id: number;

    public constructor(ptr: Ptr<typeof SCRIPT_SESSION_TYPE>) {
        this.ptr = ptr;
        this.catalog_entry_id = this.ptr.api.instanceExports.dashql_script_session_get_catalog_entry_id(
            ptr.assertNotNull(),
        );
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
        const ptr = this.ptr.api.callSRetPtr(SCRIPT_EXECUTION_TYPE, resultPtr =>
            this.ptr.api.instanceExports.dashql_script_execution_new(
                resultPtr,
                this.ptr.assertNotNull(),
                formattingConfig.dialect,
                formattingConfig.mode,
                formattingConfig.maxWidth,
                formattingConfig.indentationWidth,
                formattingConfig.debugMode,
            )
        );
        const execution = new DashQLScriptExecution(ptr);
        this.ptr.api.registerMemory({ type: SCRIPT_EXECUTION_TYPE, value: execution.ptr });
        return execution;
    }

    public getCatalogEntryId(): number {
        return this.ptr.api.instanceExports.dashql_script_session_get_catalog_entry_id(this.ptr.assertNotNull());
    }

    public getText(): string {
        const sessionPtr = this.ptr.assertNotNull();
        return this.ptr.api.readStringResult((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_get_text(resultPtr, sessionPtr)
        );
    }

    public getDocumentRevision(): bigint {
        return this.ptr.api.instanceExports.dashql_script_session_get_document_revision(this.ptr.assertNotNull());
    }

    public getStateRevision(): bigint {
        return this.ptr.api.instanceExports.dashql_script_session_get_state_revision(this.ptr.assertNotNull());
    }

    public getCatalogRevision(): bigint {
        return this.ptr.api.instanceExports.dashql_script_session_get_catalog_revision(this.ptr.assertNotNull());
    }

    public replaceText(expectedDocumentRevision: bigint, text: string): buffers.editor.EditorUpdateT {
        const sessionPtr = this.ptr.assertNotNull();
        const [textBegin, textLength] = this.ptr.api.copyString(text);
        return this.readUpdate((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_replace_text(
                resultPtr,
                sessionPtr,
                expectedDocumentRevision,
                textBegin,
                textLength,
            )
        );
    }

    public apply(event: buffers.editor.EditorEventT): buffers.editor.EditorUpdateT {
        const sessionPtr = this.ptr.assertNotNull();
        const builder = new flatbuffers.Builder();
        builder.finish(event.pack(builder));
        const [eventBegin, eventLength] = this.ptr.api.copyBuffer(builder.asUint8Array());
        try {
            return this.readUpdate((resultPtr) =>
                this.ptr.api.instanceExports.dashql_script_session_apply(
                    resultPtr,
                    sessionPtr,
                    eventBegin,
                    eventLength,
                )
            );
        } finally {
            this.ptr.api.instanceExports.dashql_free(eventBegin);
        }
    }

    public setCursor(expectedDocumentRevision: bigint, offset: bigint): buffers.editor.EditorUpdateT {
        const sessionPtr = this.ptr.assertNotNull();
        return this.readUpdate((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_set_primary_cursor(
                resultPtr,
                sessionPtr,
                expectedDocumentRevision,
                offset,
            )
        );
    }

    public analyze(): buffers.editor.EditorUpdateT {
        const sessionPtr = this.ptr.assertNotNull();
        return this.readUpdate((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_analyze(resultPtr, sessionPtr)
        );
    }

    public completeAtCursor(limit: number, keywordCase = buffers.formatting.KeywordCase.LOWER): FlatBufferPtr<buffers.completion.Completion> {
        const sessionPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.completion.Completion, buffers.completion.CompletionT>(
            COMPLETION_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_session_complete_at_cursor(
                resultPtr,
                sessionPtr,
                limit,
                keywordCase,
            ),
            () => new buffers.completion.Completion(),
        );
        this.ptr.api.registerMemory({ type: COMPLETION_TYPE, value: resultBuffer });
        return resultBuffer;
    }

    public compileQuery(
        config: buffers.formatting.FormattingConfigT,
        allowExtensions: boolean = true,
        parseIfOutdated: boolean = true,
    ): FlatBufferPtr<buffers.execution.ScriptCompilationResult> {
        const sessionPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.execution.ScriptCompilationResult, buffers.execution.ScriptCompilationResultT>(
            SCRIPT_COMPILATION_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_session_compile_query(
                resultPtr,
                sessionPtr,
                config.dialect,
                config.mode,
                config.maxWidth,
                config.indentationWidth,
                allowExtensions,
                parseIfOutdated,
            ),
            () => new buffers.execution.ScriptCompilationResult(),
        );
        this.ptr.api.registerMemory({ type: SCRIPT_COMPILATION_TYPE, value: resultBuffer });
        return resultBuffer;
    }

    public format(
        config: buffers.formatting.FormattingConfigT,
        catalog: DashQLCatalog | null = null,
        parseIfOutdated: boolean = true,
    ): DashQLScript {
        const sessionPtr = this.ptr.assertNotNull();
        const catalogPtr = catalog?.ptr.assertNotNull() ?? 0;
        const scriptPtr = this.ptr.api.callSRetPtr(SCRIPT_TYPE, (resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_format(
                resultPtr,
                sessionPtr,
                config.dialect,
                config.mode,
                config.maxWidth,
                config.indentationWidth,
                config.debugMode,
                config.keywordCase,
                parseIfOutdated,
                catalogPtr,
            )
        );
        const script = new DashQLScript(scriptPtr);
        this.ptr.api.registerMemory({ type: SCRIPT_TYPE, value: script.ptr });
        return script;
    }

    public rewriteDashboard(
        row: number | null,
        column: number | null,
        width: number,
        height: number,
        parseIfOutdated: boolean = true,
    ): string {
        const sessionPtr = this.ptr.assertNotNull();
        return this.ptr.api.readStringResult((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_session_rewrite_dashboard(
                resultPtr,
                sessionPtr,
                row ?? -1,
                column ?? -1,
                width,
                height,
                parseIfOutdated,
            )
        );
    }

    public isFullyFormattable(
        config: buffers.formatting.FormattingConfigT,
        parseIfOutdated: boolean = true,
    ): boolean {
        return this.ptr.api.instanceExports.dashql_script_session_is_fully_formattable(
            this.ptr.assertNotNull(),
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            parseIfOutdated,
        ) !== 0;
    }

    public computeDiff(target: DashQLScript): FlatBufferPtr<buffers.diff.ScriptDiff> {
        const sessionPtr = this.ptr.assertNotNull();
        const targetPtr = target.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.diff.ScriptDiff, buffers.diff.ScriptDiffT>(
            SCRIPT_DIFF_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_session_compute_diff(
                resultPtr,
                sessionPtr,
                targetPtr,
            ),
            () => new buffers.diff.ScriptDiff(),
        );
        this.ptr.api.registerMemory({ type: SCRIPT_DIFF_TYPE, value: resultBuffer });
        return resultBuffer;
    }

    public loadIntoCatalog(rank: number): void {
        this.ptr.api.instanceExports.dashql_script_session_load_into_catalog(this.ptr.assertNotNull(), rank);
    }

    public dropFromCatalog(): void {
        this.ptr.api.instanceExports.dashql_script_session_drop_from_catalog(this.ptr.assertNotNull());
    }

    private readUpdate(fn: (resultPtr: number) => void): buffers.editor.EditorUpdateT {
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.editor.EditorUpdate, buffers.editor.EditorUpdateT>(
            EDITOR_UPDATE_TYPE,
            fn,
            () => new buffers.editor.EditorUpdate(),
        );
        this.ptr.api.registerMemory({ type: EDITOR_UPDATE_TYPE, value: resultBuffer });
        return resultBuffer.unpackAndDestroy();
    }
}

export class DashQLScript {
    public readonly ptr: Ptr<typeof SCRIPT_TYPE>;
    public readonly catalog_entry_id: number;

    public constructor(ptr: Ptr<typeof SCRIPT_TYPE>) {
        this.ptr = ptr;
        this.catalog_entry_id = this.ptr.api.instanceExports.dashql_script_get_catalog_entry_id(ptr.assertNotNull());
    }
    /// Delete a graph
    public destroy() {
        this.ptr.destroy();
    }
    /// Get the script id
    public getCatalogEntryId(): number {
        return this.ptr.api.instanceExports.dashql_script_get_catalog_entry_id(this.ptr.assertNotNull());
    }
    /// Whether formatting can complete without unsupported-node placeholders.
    public isFullyFormattable(config: buffers.formatting.FormattingConfigT, parseIfOutdated: boolean = true): boolean {
        return this.ptr.api.instanceExports.dashql_script_is_fully_formattable(
            this.ptr.assertNotNull(),
            config.dialect,
            config.mode,
            config.maxWidth,
            config.indentationWidth,
            config.debugMode,
            parseIfOutdated,
        ) !== 0;
    }
    /// AST node ids that prevent formatting.
    public getUnformattableNodes(config: buffers.formatting.FormattingConfigT, parseIfOutdated: boolean = true): number[] {
        return this.ptr.api.readUint32ArrayResult((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_get_unformattable_nodes(
                resultPtr,
                this.ptr.assertNotNull(),
                config.dialect,
                config.mode,
                config.maxWidth,
                config.indentationWidth,
                config.debugMode,
                parseIfOutdated,
            )
        );
    }
    /// Insert text at an offset
    public insertTextAt(offset: number, text: string) {
        const scriptPtr = this.ptr.assertNotNull();
        // Short-circuit inserting texts of length 1
        if (text.length == 1) {
            this.ptr.api.instanceExports.dashql_script_insert_char_at(scriptPtr, offset, text.charCodeAt(0));
            return;
        }
        const [textBegin, textLength] = this.ptr.api.copyString(text);
        this.ptr.api.instanceExports.dashql_script_insert_text_at(scriptPtr, offset, textBegin, textLength);
    }
    /// Earse a range of characters
    public eraseTextRange(offset: number, length: number) {
        const scriptPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.dashql_script_erase_text_range(scriptPtr, offset, length);
    }
    /// Replace the text text
    public replaceText(text: string) {
        const scriptPtr = this.ptr.assertNotNull();
        const [textBegin, textLength] = this.ptr.api.copyString(text);
        this.ptr.api.instanceExports.dashql_script_replace_text(scriptPtr, textBegin, textLength);
    }
    /// Convert the script, or a UTF-8 byte range of it, to a string.
    public toString(offset?: number, length?: number): string {
        const scriptPtr = this.ptr.assertNotNull();
        return this.ptr.api.readStringResult((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_to_string(
                resultPtr,
                scriptPtr,
                offset ?? 0,
                length ?? 0,
            )
        );
    }
    /// Return the first parsed statement without its separator or surrounding trivia.
    public getStatementText(parseIfOutdated: boolean = true): string {
        const scriptPtr = this.ptr.assertNotNull();
        return this.ptr.api.readStringResult((resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_get_statement_text(
                resultPtr,
                scriptPtr,
                parseIfOutdated,
            )
        );
    }
    /// Compile the script into an executable query.
    public compileQuery(
        config: buffers.formatting.FormattingConfigT,
        allowExtensions: boolean = true,
        parseIfOutdated: boolean = true,
    ): FlatBufferPtr<buffers.execution.ScriptCompilationResult> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.execution.ScriptCompilationResult, buffers.execution.ScriptCompilationResultT>(
            SCRIPT_COMPILATION_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_compile_query(
                resultPtr,
                scriptPtr,
                config.dialect,
                config.mode,
                config.maxWidth,
                config.indentationWidth,
                allowExtensions,
                parseIfOutdated,
            ),
            () => new buffers.execution.ScriptCompilationResult(),
        );
        this.ptr.api.registerMemory({ type: SCRIPT_COMPILATION_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Parse the script (throws exception on error)
    public parse() {
        const scriptPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.dashql_script_parse(scriptPtr);
    }
    /// Analyze the script (throws exception on error)
    public analyze(parseIfOutdated: boolean = true) {
        const scriptPtr = this.ptr.assertNotNull();
        this.ptr.api.instanceExports.dashql_script_analyze(scriptPtr, parseIfOutdated);
    }
    /// Get the parsed script
    public getParsed(): FlatBufferPtr<buffers.parser.ParsedScript> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.parser.ParsedScript, buffers.parser.ParsedScriptT>(
            PARSED_SCRIPT_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_get_parsed(resultPtr, scriptPtr),
            () => new buffers.parser.ParsedScript()
        );
        this.ptr.api.registerMemory({ type: PARSED_SCRIPT_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Get the analyzed script
    public getAnalyzed(): FlatBufferPtr<buffers.analyzer.AnalyzedScript> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.analyzer.AnalyzedScript, buffers.analyzer.AnalyzedScriptT>(
            ANALYZED_SCRIPT_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_get_analyzed(resultPtr, scriptPtr),
            () => new buffers.analyzer.AnalyzedScript()
        );
        this.ptr.api.registerMemory({ type: ANALYZED_SCRIPT_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Compute a statement-level semantic diff from this (source/old) script to another (target/new) script
    public computeDiff(target: DashQLScript): FlatBufferPtr<buffers.diff.ScriptDiff> {
        const sourcePtr = this.ptr.assertNotNull();
        const targetPtr = target.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.diff.ScriptDiff, buffers.diff.ScriptDiffT>(
            SCRIPT_DIFF_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_compute_diff(resultPtr, sourcePtr, targetPtr),
            () => new buffers.diff.ScriptDiff()
        );
        this.ptr.api.registerMemory({ type: SCRIPT_DIFF_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Move the cursor
    public moveCursor(textOffset: number): FlatBufferPtr<buffers.cursor.ScriptCursor> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.cursor.ScriptCursor, buffers.cursor.ScriptCursorT>(
            CURSOR_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_move_cursor(resultPtr, scriptPtr, textOffset),
            () => new buffers.cursor.ScriptCursor()
        );
        this.ptr.api.registerMemory({ type: CURSOR_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Complete at the cursor
    public completeAtCursor(limit: number, keywordCase = buffers.formatting.KeywordCase.LOWER): FlatBufferPtr<buffers.completion.Completion> {
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.completion.Completion, buffers.completion.CompletionT>(
            COMPLETION_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_complete_at_cursor(resultPtr, scriptPtr, limit, keywordCase),
            () => new buffers.completion.Completion()
        );
        this.ptr.api.registerMemory({ type: COMPLETION_TYPE, value: resultBuffer });
        return resultBuffer;
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
        const scriptPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.statistics.ScriptStatistics, buffers.statistics.ScriptStatisticsT>(
            SCRIPT_STATISTICS_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_script_get_statistics(resultPtr, scriptPtr),
            () => new buffers.statistics.ScriptStatistics()
        );
        this.ptr.api.registerMemory({ type: SCRIPT_STATISTICS_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Format the script
    public format(
        config: buffers.formatting.FormattingConfigT,
        catalog: DashQLCatalog | null = null,
        parseIfOutdated: boolean = true,
    ): DashQLScript {
        const scriptPtr = this.ptr.assertNotNull();
        const catalogPtr = catalog?.ptr.assertNotNull() ?? 0;
        const newScriptPtr = this.ptr.api.callSRetPtr(SCRIPT_TYPE, (resultPtr) =>
            this.ptr.api.instanceExports.dashql_script_format(
                resultPtr,
                scriptPtr,
                config.dialect,
                config.mode,
                config.maxWidth,
                config.indentationWidth,
                config.debugMode,
                config.keywordCase,
                parseIfOutdated,
                catalogPtr)
        );
        const script = new DashQLScript(newScriptPtr);
        this.ptr.api.registerMemory({ type: SCRIPT_TYPE, value: script.ptr });
        return script;

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
    public readonly ptr: Ptr<typeof CATALOG_TYPE>;
    public snapshot: DashQLCatalogSnapshot | null;

    public constructor(ptr: Ptr<typeof CATALOG_TYPE>) {
        this.ptr = ptr;
        this.snapshot = null;
    }
    /// Delete the graph
    public destroy() {
        this.ptr?.destroy();
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
        this.ptr.api.instanceExports.dashql_catalog_clear(this.ptr.assertNotNull());
    }
    public allocateEntryId(): number {
        return this.ptr.api.instanceExports.dashql_catalog_allocate_entry_id(this.ptr.assertNotNull());
    }
    public replaceDescriptor(catalogEntryId: number, rank: number, descriptor: Uint8Array): void {
        const catalogPtr = this.ptr.assertNotNull();
        assertUint32(catalogEntryId, 'catalogEntryId');
        assertUint32(rank, 'rank');
        const [inputPtr, inputLength] = this.ptr.api.copyBuffer(descriptor);
        try {
            this.ptr.api.instanceExports.dashql_catalog_replace_descriptor(catalogPtr, catalogEntryId, rank, inputPtr, inputLength);
            this.deleteSnapshot();
        } finally {
            this.ptr.api.instanceExports.dashql_free(inputPtr);
        }
    }
    public dropDescriptor(id: number): void {
        assertUint32(id, 'catalogEntryId');
        this.ptr.api.instanceExports.dashql_catalog_drop_descriptor(this.ptr.assertNotNull(), id);
        this.deleteSnapshot();
    }
    /// Contains an entry id?
    public containsEntryId(entryId: number): boolean {
        return !!this.ptr.api.instanceExports.dashql_catalog_contains_entry_id(this.ptr.assertNotNull(), entryId);
    }
    /// Describe catalog entries
    public describeEntries(): FlatBufferPtr<buffers.catalog.CatalogEntries> {
        const catalogPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.catalog.CatalogEntries>(
            CATALOG_ENTRIES_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_catalog_describe_entries(resultPtr, catalogPtr),
            () => new buffers.catalog.CatalogEntries()
        );
        this.ptr.api.registerMemory({ type: CATALOG_ENTRIES_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Describe catalog entries
    public describeEntriesOf(id: number): FlatBufferPtr<buffers.catalog.CatalogEntries> {
        const catalogPtr = this.ptr.assertNotNull();
        const resultBuffer = this.ptr.api.callSRetFlatBufPtr<buffers.catalog.CatalogEntries>(
            CATALOG_ENTRIES_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_catalog_describe_entries_of(resultPtr, catalogPtr, id),
            () => new buffers.catalog.CatalogEntries()
        );
        this.ptr.api.registerMemory({ type: CATALOG_ENTRIES_TYPE, value: resultBuffer });
        return resultBuffer;
    }
    /// Export a catalog snapshot
    public createSnapshot(): DashQLCatalogSnapshot {
        if (this.snapshot != null) {
            return this.snapshot;
        }
        const catalogPtr = this.ptr.assertNotNull();
        const snapshot = this.ptr.api.callSRetFlatBufPtr<buffers.catalog.FlatCatalog>(
            FLAT_CATALOG_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_catalog_flatten(resultPtr, catalogPtr),
            () => new buffers.catalog.FlatCatalog()
        );
        this.snapshot = new DashQLCatalogSnapshot(snapshot);
        this.ptr.api.registerMemory({ type: FLAT_CATALOG_TYPE, value: snapshot });
        return this.snapshot;
    }
    /// Add a script in the registry (throws exception on error)
    public loadScript(script: DashQLScript, rank: number) {
        this.deleteSnapshot();
        this.ptr.api.instanceExports.dashql_catalog_load_script(this.ptr.assertNotNull(), script.ptr.assertNotNull(), rank);
    }
    /// Atomically add or replace ranked scripts in the catalog.
    public loadScripts(scripts: ReadonlyArray<readonly [DashQLScript, number]>): void {
        if (scripts.length === 0) {
            return;
        }
        const stack = this.ptr.api.module.stackSave();
        try {
            const scriptPtrs = this.ptr.api.module.stackAlloc(scripts.length * 4);
            const ranks = this.ptr.api.module.stackAlloc(scripts.length * 4);
            const scriptHeap = this.ptr.api.module.HEAPU32.subarray(scriptPtrs / 4, scriptPtrs / 4 + scripts.length);
            const rankHeap = this.ptr.api.module.HEAPU32.subarray(ranks / 4, ranks / 4 + scripts.length);
            for (let i = 0; i < scripts.length; ++i) {
                scriptHeap[i] = scripts[i][0].ptr.assertNotNull();
                rankHeap[i] = scripts[i][1];
            }
            this.ptr.api.instanceExports.dashql_catalog_load_scripts(
                this.ptr.assertNotNull(), scriptPtrs, ranks, scripts.length
            );
            this.deleteSnapshot();
        } finally {
            this.ptr.api.module.stackRestore(stack);
        }
    }
    /// Update a script from the registry
    public dropScript(script: DashQLScript) {
        this.deleteSnapshot();
        this.ptr.api.instanceExports.dashql_catalog_drop_script(this.ptr.assertNotNull(), script.ptr.assertNotNull());
    }
    /// Get the catalog statistics.
    public getStatistics(): FlatBufferPtr<buffers.catalog.CatalogStatistics, buffers.catalog.CatalogStatisticsT> {
        const catalogPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.callSRetFlatBufPtr<buffers.catalog.CatalogStatistics>(
            CATALOG_STATISTICS_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_catalog_get_statistics(resultPtr, catalogPtr),
            () => new buffers.catalog.CatalogStatistics()
        );
        this.ptr.api.registerMemory({ type: CATALOG_STATISTICS_TYPE, value: resultPtr });
        return resultPtr;
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
    public readonly ptr: Ptr<typeof CATALOG_TYPE>;
    public layout: buffers.view.PlanLayoutConfigT;
    public buffer: FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> | null;

    public constructor(ptr: Ptr<typeof CATALOG_TYPE>, layout: buffers.view.PlanLayoutConfigT) {
        this.ptr = ptr;
        this.layout = layout;
        this.reconfigure(layout);
        this.buffer = null;
    }
    /// Delete the plan view model
    public destroy() {
        this.ptr?.destroy();
        this.buffer?.destroy();
    }
    /// Reconfigure the plan view model
    public reconfigure(config: buffers.view.PlanLayoutConfigT) {
        this.layout = config;
        this.ptr.api.instanceExports.dashql_plan_view_model_configure(
            this.ptr.assertNotNull(),
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
    /// Pack a Hyper plan as FlatBuffer
    public pack(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        const viewModelPtr = this.ptr.assertNotNull();
        const resultPtr = this.ptr.api.callSRetFlatBufPtr<buffers.view.PlanViewModel>(
            FLAT_PLAN_VIEW_MODEL_TYPE,
            (resultPtr) => this.ptr.api.instanceExports.dashql_plan_view_model_pack(resultPtr, viewModelPtr),
            () => new buffers.view.PlanViewModel()
        );
        this.ptr.api.registerMemory({ type: FLAT_PLAN_VIEW_MODEL_TYPE, value: resultPtr });
        this.buffer?.destroy();
        this.buffer = resultPtr;
        return this.buffer;
    }
    /// Reset a Hyper plan
    public reset(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        this.ptr.api.instanceExports.dashql_plan_view_model_reset(this.ptr.assertNotNull());
        this.buffer?.destroy();
        this.buffer = null;
        this.buffer = this.pack();
        return this.buffer;
    }
    /// Reset a Hyper plan
    public resetExecution(): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        this.ptr.api.instanceExports.dashql_plan_view_model_reset_execution(this.ptr.assertNotNull());
        this.buffer?.destroy();
        this.buffer = null;
        this.buffer = this.pack();
        return this.buffer;
    }
    /// Load a Hyper plan (throws exception on error)
    public loadHyperPlan(plan: string): FlatBufferPtr<buffers.view.PlanViewModel, buffers.view.PlanViewModelT> {
        const [textBegin, textLength] = this.ptr.api.copyString(plan);
        this.ptr.api.instanceExports.dashql_plan_view_model_load_hyper_plan(this.ptr.assertNotNull(), textBegin, textLength);
        this.buffer?.destroy();
        this.buffer = null;
        this.buffer = this.pack();
        return this.buffer;
    }
}
