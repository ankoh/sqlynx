import createDashQLShellModule from '@ankoh/dashql-shell-js';
import shellWasmUrl from '@ankoh/dashql-shell-wasm?url';
import { DashQL, DashQLCatalog, DashQLModuleOptions, DashQLScript, EmscriptenModule } from '@ankoh/dashql-core';
import * as dashql from '@ankoh/dashql-core';
import { stringifyError } from '../platform/logger/logger.js';

const RESULT_SIZE = 16;
const RESULT_STATUS = 0;
const RESULT_DATA_LENGTH = 1;
const RESULT_DATA_POINTER = 2;
const EFFECT_HEADER_SIZE = 16;
const EFFECT_VERSION = 1;
const PROMPT_RESULT_SIZE = 40;
const TERMINAL_RESULT_SIZE = 20;
const COMPLETION_RESULT_SIZE = 12;
const COMPLETION_CANDIDATE_SIZE = 24;

export enum DashQLShellStatus {
    OK = 0,
    INVALID_ARGUMENT = 1,
    ARROW_ERROR = 2,
    INTERNAL_ERROR = 3,
    PENDING = 4,
    STALE_EFFECT = 5,
    BUSY = 6,
}

export enum DashQLShellEffectType {
    EXECUTE_QUERY = 1,
    EXECUTE_COMMAND = 2,
}

enum DashQLShellEffectCompletionStatus {
    SUCCESS = 0,
    ERROR = 1,
    CANCELLED = 2,
}

export interface DashQLShellModule extends EmscriptenModule {
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    _dashql_shell_new(catalog: number, terminalColumns: number, autoQualifyNonDefaultDatabaseTables: boolean): number;
    _dashql_shell_destroy(shell: number): void;
    _dashql_shell_resize(shell: number, terminalColumns: number): void;
    _dashql_shell_keyword_case_set(shell: number, keywordCase: number): void;
    _dashql_shell_session_relations_set(shell: number, enabled: boolean): number;
    _dashql_shell_commands_set(shell: number, commands: number, commandsLength: number): number;
    _dashql_shell_prompt_set(shell: number, text: number, textLength: number, result: number): number;
    _dashql_shell_prompt_insert(shell: number, text: number, textLength: number, result: number): number;
    _dashql_shell_prompt_move_left(shell: number, result: number): number;
    _dashql_shell_prompt_move_right(shell: number, result: number): number;
    _dashql_shell_prompt_delete_backward(shell: number, result: number): number;
    _dashql_shell_prompt_delete_forward(shell: number, result: number): number;
    _dashql_shell_prompt_complete(shell: number, limit: number, result: number): number;
    _dashql_shell_prompt_apply_completion(shell: number, candidate: number, result: number): number;
    _dashql_shell_prompt_consume(shell: number, key: number, text: number, textLength: number, result: number): number;
    _dashql_shell_prompt_submit(shell: number, result: number): number;
    _dashql_shell_prompt_result_destroy(result: number): void;
    _dashql_shell_completion_result_destroy(result: number): void;
    _dashql_shell_terminal_open(shell: number, prompt: number, promptLength: number, result: number): number;
    _dashql_shell_terminal_consume(shell: number, key: number, text: number, textLength: number, result: number): number;
    _dashql_shell_terminal_finish_query(shell: number, output: number, outputLength: number, error: boolean, result: number): number;
    _dashql_shell_terminal_query_progress(shell: number, message: number, messageLength: number, advanceFrame: boolean, result: number): number;
    _dashql_shell_terminal_query_progress_clear(shell: number, result: number): number;
    _dashql_shell_terminal_status(shell: number, message: number, messageLength: number, result: number): number;
    _dashql_shell_terminal_result_destroy(result: number): void;
    _dashql_shell_history_export(shell: number, result: number): number;
    _dashql_shell_history_import(shell: number, data: number, dataLength: number, result: number): number;
    _dashql_shell_start_query(shell: number, query: number, queryLength: number, result: number): number;
    _dashql_shell_complete_effect(
        shell: number,
        effectIdLow: number,
        effectIdHigh: number,
        completionStatus: number,
        data: number,
        dataLength: number,
        result: number,
    ): number;
    _dashql_shell_cancel_effect(
        shell: number,
        effectIdLow: number,
        effectIdHigh: number,
        result: number,
    ): number;
    _dashql_shell_result_destroy(result: number): void;
}

export interface DashQLShellEnvironment {
    executeQuery(
        query: string,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
        onTiming?: (label: string, elapsedMs: number) => void,
    ): Promise<Uint8Array>;
}

export interface DashQLShellCommandContext {
    readonly signal?: AbortSignal;
    readonly onProgress?: (message: string) => void;
}

export type DashQLShellCommandFunction = (
    args: readonly string[],
    context: DashQLShellCommandContext,
) => string | void | Promise<string | void>;

export type DashQLShellCommand = readonly [
    name: string,
    description: string,
    execute: DashQLShellCommandFunction,
];

interface DashQLShellOperation {
    status: DashQLShellStatus;
    data: Uint8Array;
}

interface DashQLShellEffect {
    id: bigint;
    type: DashQLShellEffectType;
    payload: Uint8Array;
}

interface DashQLShellEffectResult {
    status: DashQLShellEffectCompletionStatus;
    data: Uint8Array;
}

interface DashQLShellSettings {
    timer: boolean;
}

export interface DashQLShellOptions {
    environment: DashQLShellEnvironment;
    trackSessionRelations?: boolean;
    autoQualifyNonDefaultDatabaseTables?: boolean;
    commands?: readonly DashQLShellCommand[];
    terminalColumns?: number;
    instantiateWasm?: DashQLModuleOptions['instantiateWasm'];
    onProgress?: (progress: DashQLShellInstantiationProgress) => void;
    wasmBinary?: Uint8Array;
    wasmUrl?: string | URL;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
}

export interface DashQLShellInstantiationProgress {
    bytesLoaded: number;
    bytesTotal: number;
}

interface DashQLShellModuleCacheEntry {
    url: string;
    promise: Promise<DashQLShellModule>;
    progress: DashQLShellInstantiationProgress | null;
    listeners: Set<(progress: DashQLShellInstantiationProgress) => void>;
}

const shellModuleGlobal = globalThis as typeof globalThis & {
    __dashqlShellModuleCache?: DashQLShellModuleCacheEntry;
    __DASHQL_TEST_SHARE_SHELL_MODULE__?: boolean;
};

export interface DashQLShellPrompt {
    revision: bigint;
    cursorByteOffset: number;
    text: string;
    message: string;
    action: DashQLShellPromptAction;
}

export interface DashQLShellTerminalOutput {
    action: DashQLShellPromptAction;
    data: string;
}

export enum DashQLShellPromptInput {
    TEXT = 0,
    ENTER = 1,
    FORCE_SUBMIT = 2,
    TAB = 3,
    BACKSPACE = 4,
    DELETE = 5,
    LEFT = 6,
    RIGHT = 7,
    HISTORY_PREVIOUS = 8,
    HISTORY_NEXT = 9,
    CANCEL = 10,
    ESCAPE = 11,
    UP = 12,
    DOWN = 13,
    START = 14,
    END = 15,
    LINE_START = 16,
    LINE_END = 17,
    WORD_LEFT = 18,
    WORD_RIGHT = 19,
    KILL_LINE = 20,
    BACKWARD_KILL_LINE = 21,
    KILL_WORD = 22,
    BACKWARD_KILL_WORD = 23,
    YANK = 24,
    TRANSPOSE = 25,
    CLEAR_SCREEN = 26,
    EOF = 27,
    ABORT = 28,
}

export enum DashQLShellPromptAction {
    NONE = 0,
    SUBMIT = 1,
    COMPLETE = 2,
    EXIT = 3,
}

export interface DashQLShellCompletionCandidate {
    displayText: string;
    completionText: string;
    targetOffset: number;
    targetLength: number;
}

export class DashQLShellError extends Error {
    constructor(
        public readonly status: DashQLShellStatus,
        message: string,
    ) {
        super(message);
        this.name = 'DashQLShellError';
    }
}

export class DashQLShell {
    protected readonly textDecoder = new TextDecoder();
    protected readonly textEncoder = new TextEncoder();
    protected shell: number;
    protected readonly lifecycleAbort = new AbortController();
    protected activeExecution: AbortController | null = null;
    protected readonly catalogScripts: DashQLScript[] = [];
    protected readonly commands: Map<string, DashQLShellCommand>;
    protected readonly settings: DashQLShellSettings;

    protected constructor(
        protected readonly module: DashQLShellModule,
        public readonly core: DashQL,
        public readonly catalog: DashQLCatalog,
        protected readonly environment: DashQLShellEnvironment,
        terminalColumns: number,
        autoQualifyNonDefaultDatabaseTables: boolean,
        commands: Map<string, DashQLShellCommand>,
        settings: DashQLShellSettings,
    ) {
        this.commands = commands;
        this.settings = settings;
        this.shell = module._dashql_shell_new(
            catalog.ptr.assertNotNull(),
            terminalColumns,
            autoQualifyNonDefaultDatabaseTables,
        );
        if (this.shell === 0) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to create DashQL shell');
        }
        const commandNames = this.textEncoder.encode(Array.from(commands.keys()).join('\n'));
        const commandNamesPointer = this.module._dashql_malloc(commandNames.byteLength);
        if (commandNamesPointer === 0) {
            this.module._dashql_shell_destroy(this.shell);
            this.shell = 0;
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate shell commands');
        }
        try {
            this.module.HEAPU8.set(commandNames, commandNamesPointer);
            const status = this.module._dashql_shell_commands_set(
                this.shell,
                commandNamesPointer,
                commandNames.byteLength,
            ) as DashQLShellStatus;
            if (status !== DashQLShellStatus.OK) {
                this.module._dashql_shell_destroy(this.shell);
                this.shell = 0;
                throw new DashQLShellError(status, 'failed to configure shell commands');
            }
        } finally {
            this.module._dashql_free(commandNamesPointer);
        }
    }

    static async create(options: DashQLShellOptions): Promise<DashQLShell> {
        const settings: DashQLShellSettings = { timer: false };
        const commands = createShellCommands(options.commands ?? [], settings);
        const wasmUrl = options.wasmUrl?.toString() ?? shellWasmUrl;
        const instantiateModule = async (
            onProgress: ((progress: DashQLShellInstantiationProgress) => void) | undefined,
        ): Promise<DashQLShellModule> => {
            const instantiateWasm = options.instantiateWasm ?? (options.wasmBinary == null && onProgress != null
            ? async (imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
                const response = await fetch(wasmUrl);
                if (!response.ok) throw new Error(`failed to fetch shell Wasm: ${response.status} ${response.statusText}`);
                const bytesTotal = Number(response.headers.get('content-length')) || 0;
                let bytesLoaded = 0;
                onProgress({ bytesLoaded, bytesTotal });
                const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                        bytesLoaded += chunk.byteLength;
                        onProgress({ bytesLoaded, bytesTotal });
                        controller.enqueue(chunk);
                    },
                }));
                const result = body == null
                    ? await WebAssembly.instantiate(await response.arrayBuffer(), imports)
                    : await WebAssembly.instantiateStreaming(new Response(body, response), imports);
                successCallback(result.instance, result.module);
                return {};
            }
            : undefined);
            return await createDashQLShellModule({
                instantiateWasm,
                wasmBinary: options.wasmBinary,
                locateFile: path => path.endsWith('.wasm') ? wasmUrl : path,
                print: options.print,
                printErr: options.printErr,
            }) as unknown as DashQLShellModule;
        };

        let module: DashQLShellModule;
        if ((options.wasmBinary != null || options.instantiateWasm != null)
            && !shellModuleGlobal.__DASHQL_TEST_SHARE_SHELL_MODULE__) {
            module = await instantiateModule(options.onProgress);
        } else {
            let entry = shellModuleGlobal.__dashqlShellModuleCache;
            if (entry == null || entry.url !== wasmUrl) {
                const listeners = new Set<(progress: DashQLShellInstantiationProgress) => void>();
                entry = {
                    url: wasmUrl,
                    progress: null,
                    listeners,
                    promise: Promise.resolve(null as unknown as DashQLShellModule),
                };
                entry.promise = instantiateModule(progress => {
                    entry!.progress = progress;
                    for (const listener of listeners) listener(progress);
                }).catch(error => {
                    if (shellModuleGlobal.__dashqlShellModuleCache === entry) {
                        delete shellModuleGlobal.__dashqlShellModuleCache;
                    }
                    throw error;
                });
                shellModuleGlobal.__dashqlShellModuleCache = entry;
            }
            if (options.onProgress != null) {
                entry.listeners.add(options.onProgress);
                if (entry.progress != null) options.onProgress(entry.progress);
            }
            try {
                module = await entry.promise;
            } finally {
                if (options.onProgress != null) entry.listeners.delete(options.onProgress);
            }
        }
        const core = new DashQL(module);
        const catalog = core.createCatalog();
        const shell = new DashQLShell(
            module,
            core,
            catalog,
            options.environment,
            options.terminalColumns ?? 100,
            options.autoQualifyNonDefaultDatabaseTables ?? false,
            commands,
            settings,
        );
        if (options.trackSessionRelations) {
            const status = module._dashql_shell_session_relations_set(shell.shell, true) as DashQLShellStatus;
            if (status !== DashQLShellStatus.OK) {
                shell.destroy();
                throw new DashQLShellError(status, 'failed to enable session relation tracking');
            }
        }
        return shell;
    }

    loadCatalogScript(text: string, rank: number): DashQLScript {
        this.assertAlive();
        const script = this.core.createScript(this.catalog);
        try {
            script.replaceText(text);
            if (text.trim().length !== 0) {
                script.analyze();
                this.catalog.loadScript(script, rank);
            }
            this.catalogScripts.push(script);
            return script;
        } catch (error) {
            script.destroy();
            throw error;
        }
    }

    replaceCatalogScript(script: DashQLScript, text: string, rank: number): void {
        this.assertAlive();
        script.replaceText(text);
        script.analyze();
        this.catalog.loadScript(script, rank);
    }

    resize(terminalColumns: number): void {
        this.assertAlive();
        this.module._dashql_shell_resize(this.shell, terminalColumns);
    }

    setKeywordCase(keywordCase: dashql.buffers.formatting.KeywordCase): void {
        this.assertAlive();
        this.module._dashql_shell_keyword_case_set(this.shell, keywordCase);
    }

    setPrompt(text: string): DashQLShellPrompt {
        return this.invokePrompt(this.textEncoder.encode(text), (input, inputLength, result) => {
            this.module._dashql_shell_prompt_set(this.shell, input, inputLength, result);
        });
    }

    insertPrompt(text: string): DashQLShellPrompt {
        return this.invokePrompt(this.textEncoder.encode(text), (input, inputLength, result) => {
            this.module._dashql_shell_prompt_insert(this.shell, input, inputLength, result);
        });
    }

    movePromptLeft(): DashQLShellPrompt {
        return this.invokePrompt(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_prompt_move_left(this.shell, result);
        });
    }

    movePromptRight(): DashQLShellPrompt {
        return this.invokePrompt(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_prompt_move_right(this.shell, result);
        });
    }

    deletePromptBackward(): DashQLShellPrompt {
        return this.invokePrompt(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_prompt_delete_backward(this.shell, result);
        });
    }

    deletePromptForward(): DashQLShellPrompt {
        return this.invokePrompt(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_prompt_delete_forward(this.shell, result);
        });
    }

    completePrompt(limit = 20): DashQLShellCompletionCandidate[] {
        this.assertAlive();
        const result = this.module._dashql_malloc(COMPLETION_RESULT_SIZE);
        if (result === 0) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate completion result');
        }
        try {
            this.module.HEAPU32.fill(0, result >>> 2, (result + COMPLETION_RESULT_SIZE) >>> 2);
            const status = this.module._dashql_shell_prompt_complete(this.shell, limit, result) as DashQLShellStatus;
            if (status !== DashQLShellStatus.OK) {
                throw new DashQLShellError(status, 'failed to complete shell prompt');
            }
            const resultIndex = result >>> 2;
            const count = this.module.HEAPU32[resultIndex];
            const candidates = this.module.HEAPU32[resultIndex + 1];
            const output: DashQLShellCompletionCandidate[] = [];
            for (let i = 0; i < count; ++i) {
                const candidate = (candidates + i * COMPLETION_CANDIDATE_SIZE) >>> 2;
                const displayLength = this.module.HEAPU32[candidate];
                const displayPointer = this.module.HEAPU32[candidate + 1];
                const completionLength = this.module.HEAPU32[candidate + 2];
                const completionPointer = this.module.HEAPU32[candidate + 3];
                output.push({
                    displayText: this.readText(displayPointer, displayLength),
                    completionText: this.readText(completionPointer, completionLength),
                    targetOffset: this.module.HEAPU32[candidate + 4],
                    targetLength: this.module.HEAPU32[candidate + 5],
                });
            }
            return output;
        } finally {
            this.module._dashql_shell_completion_result_destroy(result);
            this.module._dashql_free(result);
        }
    }

    applyCompletion(candidate: DashQLShellCompletionCandidate): DashQLShellPrompt {
        this.assertAlive();
        const display = this.textEncoder.encode(candidate.displayText);
        const completion = this.textEncoder.encode(candidate.completionText);
        const storage = this.module._dashql_malloc(COMPLETION_CANDIDATE_SIZE + display.byteLength + completion.byteLength);
        if (storage === 0) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate completion candidate');
        }
        try {
            const displayPointer = storage + COMPLETION_CANDIDATE_SIZE;
            const completionPointer = displayPointer + display.byteLength;
            this.module.HEAPU8.set(display, displayPointer);
            this.module.HEAPU8.set(completion, completionPointer);
            const index = storage >>> 2;
            this.module.HEAPU32.set([
                display.byteLength,
                displayPointer,
                completion.byteLength,
                completionPointer,
                candidate.targetOffset,
                candidate.targetLength,
            ], index);
            return this.invokePrompt(new Uint8Array(), (_input, _inputLength, result) => {
                this.module._dashql_shell_prompt_apply_completion(this.shell, storage, result);
            });
        } finally {
            this.module._dashql_free(storage);
        }
    }

    consumePromptInput(key: DashQLShellPromptInput, text = ''): DashQLShellPrompt {
        return this.invokePrompt(this.textEncoder.encode(text), (input, inputLength, result) => {
            this.module._dashql_shell_prompt_consume(this.shell, key, input, inputLength, result);
        });
    }

    openTerminal(prompt = 'dashql> '): DashQLShellTerminalOutput {
        return this.invokeTerminal(this.textEncoder.encode(prompt), (input, inputLength, result) => {
            this.module._dashql_shell_terminal_open(this.shell, input, inputLength, result);
        });
    }

    consumeTerminalInput(key: DashQLShellPromptInput, text = ''): DashQLShellTerminalOutput {
        return this.invokeTerminal(this.textEncoder.encode(text), (input, inputLength, result) => {
            this.module._dashql_shell_terminal_consume(this.shell, key, input, inputLength, result);
        });
    }

    finishTerminalQuery(output: string, error = false): DashQLShellTerminalOutput {
        return this.invokeTerminal(this.textEncoder.encode(output), (input, inputLength, result) => {
            this.module._dashql_shell_terminal_finish_query(this.shell, input, inputLength, error, result);
        });
    }

    renderTerminalQueryProgress(message = '', advanceFrame = false): DashQLShellTerminalOutput {
        return this.invokeTerminal(this.textEncoder.encode(message), (input, inputLength, result) => {
            this.module._dashql_shell_terminal_query_progress(
                this.shell,
                input,
                inputLength,
                advanceFrame,
                result,
            );
        });
    }

    clearTerminalQueryProgress(): DashQLShellTerminalOutput {
        return this.invokeTerminal(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_terminal_query_progress_clear(this.shell, result);
        });
    }

    renderTerminalStatus(message: string): DashQLShellTerminalOutput {
        return this.invokeTerminal(this.textEncoder.encode(message), (input, inputLength, result) => {
            this.module._dashql_shell_terminal_status(this.shell, input, inputLength, result);
        });
    }

    exportHistory(): Uint8Array {
        const operation = this.invoke(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_history_export(this.shell, result);
        });
        if (operation.status !== DashQLShellStatus.OK) {
            throw new DashQLShellError(operation.status, this.textDecoder.decode(operation.data));
        }
        return operation.data;
    }

    importHistory(data: Uint8Array): void {
        const operation = this.invoke(data, (input, inputLength, result) => {
            this.module._dashql_shell_history_import(this.shell, input, inputLength, result);
        });
        this.requireComplete(operation);
    }

    async submitPrompt(
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
    ): Promise<string> {
        this.assertAlive();
        return await this.executeOperation(() => this.invoke(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_prompt_submit(this.shell, result);
        }), signal, onProgress, onResult);
    }

    async executeQuery(
        query: string,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
    ): Promise<string> {
        return await this.executeOperation(() => this.invoke(this.textEncoder.encode(query), (input, inputLength, result) => {
            this.module._dashql_shell_start_query(this.shell, input, inputLength, result);
        }), signal, onProgress, onResult);
    }

    protected async executeOperation(
        start: () => DashQLShellOperation,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
    ): Promise<string> {
        this.assertAlive();
        if (this.activeExecution != null) {
            throw new DashQLShellError(DashQLShellStatus.BUSY, 'the shell already has an active operation');
        }
        const executionAbort = new AbortController();
        this.activeExecution = executionAbort;
        const abortExecution = () => executionAbort.abort();
        this.lifecycleAbort.signal.addEventListener('abort', abortExecution, { once: true });
        signal?.addEventListener('abort', abortExecution, { once: true });

        try {
            let operation = start();
            let queryStartedAt: number | null = null;
            const queryTimings: Array<{ label: string; elapsedMs: number }> = [];
            while (operation.status === DashQLShellStatus.PENDING) {
                const effect = this.requireEffect(operation);
                if (effect.type === DashQLShellEffectType.EXECUTE_QUERY && this.settings.timer) {
                    queryStartedAt = performance.now();
                }
                const completion = await this.runEffect(
                    effect,
                    executionAbort.signal,
                    onProgress,
                    onResult,
                    queryStartedAt == null
                        ? undefined
                        : (label, elapsedMs) => { queryTimings.push({ label, elapsedMs }); },
                );
                if (this.shell === 0) {
                    throw new DashQLShellError(DashQLShellStatus.STALE_EFFECT, 'DashQL shell was destroyed');
                }
                operation = completion.status === DashQLShellEffectCompletionStatus.CANCELLED
                    ? this.cancelEffect(effect.id)
                    : this.completeEffect(effect.id, completion.status, completion.data);
            }
            const output = this.requireComplete(operation);
            if (queryTimings.length === 0) return output;
            const separator = output.length === 0 || /(?:\r\n|\n|\r)$/.test(output) ? '' : '\r\n';
            const timingsByLabel = new Map<string, number>();
            for (const timing of queryTimings) {
                timingsByLabel.set(timing.label, (timingsByLabel.get(timing.label) ?? 0) + timing.elapsedMs);
            }
            const timings = Array.from(timingsByLabel, ([label, elapsedMs]) => `${label}: ${formatElapsed(elapsedMs)}`)
                .join(' | ');
            return `${output}${separator}${timings}\r\n`;
        } finally {
            this.lifecycleAbort.signal.removeEventListener('abort', abortExecution);
            signal?.removeEventListener('abort', abortExecution);
            if (this.activeExecution === executionAbort) {
                this.activeExecution = null;
            }
        }
    }

    protected invokePrompt(
        data: Uint8Array,
        callback: (input: number, inputLength: number, result: number) => void,
    ): DashQLShellPrompt {
        this.assertAlive();
        const input = data.byteLength === 0 ? 0 : this.module._dashql_malloc(data.byteLength);
        const result = this.module._dashql_malloc(PROMPT_RESULT_SIZE);
        if ((data.byteLength !== 0 && input === 0) || result === 0) {
            if (input !== 0) this.module._dashql_free(input);
            if (result !== 0) this.module._dashql_free(result);
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate prompt input');
        }
        try {
            if (data.byteLength !== 0) this.module.HEAPU8.set(data, input);
            this.module.HEAPU32.fill(0, result >>> 2, (result + PROMPT_RESULT_SIZE) >>> 2);
            callback(input, data.byteLength, result);
            const index = result >>> 2;
            const status = this.module.HEAPU32[index] as DashQLShellStatus;
            const message = this.readText(this.module.HEAPU32[index + 7], this.module.HEAPU32[index + 6]);
            if (status !== DashQLShellStatus.OK) {
                throw new DashQLShellError(status, message);
            }
            return {
                revision: BigInt(this.module.HEAPU32[index + 1]) | (BigInt(this.module.HEAPU32[index + 2]) << 32n),
                cursorByteOffset: this.module.HEAPU32[index + 3],
                text: this.readText(this.module.HEAPU32[index + 5], this.module.HEAPU32[index + 4]),
                message,
                action: this.module.HEAPU32[index + 9] as DashQLShellPromptAction,
            };
        } finally {
            this.module._dashql_shell_prompt_result_destroy(result);
            this.module._dashql_free(result);
            this.module._dashql_free(input);
        }
    }

    protected invokeTerminal(
        data: Uint8Array,
        callback: (input: number, inputLength: number, result: number) => void,
    ): DashQLShellTerminalOutput {
        this.assertAlive();
        const input = data.byteLength === 0 ? 0 : this.module._dashql_malloc(data.byteLength);
        const result = this.module._dashql_malloc(TERMINAL_RESULT_SIZE);
        if ((data.byteLength !== 0 && input === 0) || result === 0) {
            if (input !== 0) this.module._dashql_free(input);
            if (result !== 0) this.module._dashql_free(result);
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate terminal input');
        }
        try {
            if (data.byteLength !== 0) this.module.HEAPU8.set(data, input);
            this.module.HEAPU32.fill(0, result >>> 2, (result + TERMINAL_RESULT_SIZE) >>> 2);
            callback(input, data.byteLength, result);
            const index = result >>> 2;
            const status = this.module.HEAPU32[index] as DashQLShellStatus;
            const output = this.readText(this.module.HEAPU32[index + 3], this.module.HEAPU32[index + 2]);
            if (status !== DashQLShellStatus.OK) throw new DashQLShellError(status, output);
            return {
                action: this.module.HEAPU32[index + 1] as DashQLShellPromptAction,
                data: output,
            };
        } finally {
            this.module._dashql_shell_terminal_result_destroy(result);
            this.module._dashql_free(result);
            this.module._dashql_free(input);
        }
    }

    protected readText(pointer: number, length: number): string {
        if (length === 0) return '';
        const data = new Uint8Array(this.module.HEAPU8.subarray(pointer, pointer + length));
        return this.textDecoder.decode(data);
    }

    protected async runEffect(
        effect: DashQLShellEffect,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
        onTiming?: (label: string, elapsedMs: number) => void,
    ): Promise<DashQLShellEffectResult> {
        if (
            effect.type !== DashQLShellEffectType.EXECUTE_QUERY &&
            effect.type !== DashQLShellEffectType.EXECUTE_COMMAND
        ) {
            return {
                status: DashQLShellEffectCompletionStatus.ERROR,
                data: this.textEncoder.encode(`unsupported shell effect ${effect.type}`),
            };
        }

        return await new Promise<DashQLShellEffectResult>((resolve) => {
            let settled = false;
            const finish = (completion: DashQLShellEffectResult) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                resolve(completion);
            };
            const onAbort = () => finish({
                status: DashQLShellEffectCompletionStatus.CANCELLED,
                data: new Uint8Array(),
            });
            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });

            const effectInput = this.textDecoder.decode(effect.payload);
            Promise.resolve()
                .then(async () => {
                    if (effect.type === DashQLShellEffectType.EXECUTE_QUERY) {
                        return await this.environment.executeQuery(
                            effectInput,
                            signal,
                            onProgress,
                            onResult,
                            onTiming,
                        );
                    }
                    const command = await this.executeCommand(effectInput, signal, onProgress);
                    const output = this.textEncoder.encode(withTrailingNewline(command.output));
                    const encoded = new Uint8Array(output.byteLength + 1);
                    encoded[0] = command.clearTerminal ? 1 : 0;
                    encoded.set(output, 1);
                    return encoded;
                })
                .then(
                    data => finish({
                        status: DashQLShellEffectCompletionStatus.SUCCESS,
                        data,
                    }),
                    error => {
                        finish({
                            status: DashQLShellEffectCompletionStatus.ERROR,
                            data: this.textEncoder.encode(withTrailingNewline(stringifyError(error))),
                        });
                    },
                );
        });
    }

    protected async executeCommand(
        input: string,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
    ): Promise<{ output: string; clearTerminal: boolean }> {
        const [name, ...args] = input.trim().substring(1).split(/\s+/);
        const command = this.commands.get(name.toLowerCase());
        if (command == null) throw new Error(`unknown command: .${name}`);
        return {
            output: await command[2](args, { signal, onProgress }) ?? '',
            clearTerminal: name.toLowerCase() === 'clear',
        };
    }

    protected invoke(
        data: Uint8Array,
        callback: (input: number, inputLength: number, result: number) => void,
    ): DashQLShellOperation {
        const input = data.byteLength === 0 ? 0 : this.module._dashql_malloc(data.byteLength);
        const result = this.module._dashql_malloc(RESULT_SIZE);
        if ((data.byteLength !== 0 && input === 0) || result === 0) {
            if (input !== 0) this.module._dashql_free(input);
            if (result !== 0) this.module._dashql_free(result);
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to allocate shell input');
        }

        try {
            if (data.byteLength !== 0) {
                this.module.HEAPU8.set(data, input);
            }
            this.module.HEAPU32.fill(0, result >>> 2, (result >>> 2) + (RESULT_SIZE >>> 2));
            callback(input, data.byteLength, result);

            const resultIndex = result >>> 2;
            const status = this.module.HEAPU32[resultIndex + RESULT_STATUS] as DashQLShellStatus;
            const outputLength = this.module.HEAPU32[resultIndex + RESULT_DATA_LENGTH];
            const outputPointer = this.module.HEAPU32[resultIndex + RESULT_DATA_POINTER];
            return {
                status,
                data: new Uint8Array(this.module.HEAPU8.subarray(outputPointer, outputPointer + outputLength)),
            };
        } finally {
            this.module._dashql_shell_result_destroy(result);
            this.module._dashql_free(result);
            this.module._dashql_free(input);
        }
    }

    protected completeEffect(
        effectId: bigint,
        status: DashQLShellEffectCompletionStatus,
        data: Uint8Array,
    ): DashQLShellOperation {
        const [low, high] = this.splitEffectId(effectId);
        return this.invoke(data, (input, inputLength, result) => {
            this.module._dashql_shell_complete_effect(
                this.shell,
                low,
                high,
                status,
                input,
                inputLength,
                result,
            );
        });
    }

    protected cancelEffect(effectId: bigint): DashQLShellOperation {
        const [low, high] = this.splitEffectId(effectId);
        return this.invoke(new Uint8Array(), (_input, _inputLength, result) => {
            this.module._dashql_shell_cancel_effect(this.shell, low, high, result);
        });
    }

    protected requireComplete(operation: DashQLShellOperation): string {
        if (operation.status !== DashQLShellStatus.OK) {
            throw new DashQLShellError(operation.status, this.textDecoder.decode(operation.data));
        }
        return this.textDecoder.decode(operation.data);
    }

    protected requireEffect(operation: DashQLShellOperation): DashQLShellEffect {
        if (operation.status !== DashQLShellStatus.PENDING) {
            throw new DashQLShellError(operation.status, this.textDecoder.decode(operation.data));
        }
        if (operation.data.byteLength < EFFECT_HEADER_SIZE) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'invalid shell effect envelope');
        }
        const view = new DataView(operation.data.buffer, operation.data.byteOffset, operation.data.byteLength);
        const version = view.getUint32(0, true);
        if (version !== EFFECT_VERSION) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, `unsupported shell effect version ${version}`);
        }
        return {
            type: view.getUint32(4, true) as DashQLShellEffectType,
            id: view.getBigUint64(8, true),
            payload: operation.data.subarray(EFFECT_HEADER_SIZE),
        };
    }

    protected splitEffectId(effectId: bigint): [number, number] {
        return [Number(effectId & 0xffffffffn), Number(effectId >> 32n)];
    }

    destroy(): void {
        if (this.shell !== 0) {
            this.lifecycleAbort.abort();
            this.module._dashql_shell_destroy(this.shell);
            this.shell = 0;
            for (let i = this.catalogScripts.length - 1; i >= 0; --i) {
                this.catalogScripts[i].destroy();
            }
            this.catalogScripts.length = 0;
            this.catalog.destroy();
        }
    }

    protected assertAlive(): void {
        if (this.shell === 0) {
            throw new DashQLShellError(DashQLShellStatus.INVALID_ARGUMENT, 'DashQL shell has been destroyed');
        }
    }
}

function createShellCommands(
    extensions: readonly DashQLShellCommand[],
    settings: DashQLShellSettings,
): Map<string, DashQLShellCommand> {
    const commands = new Map<string, DashQLShellCommand>();
    const register = (command: DashQLShellCommand) => {
        const name = command[0].toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid shell command name: ${command[0]}`);
        if (commands.has(name)) throw new Error(`duplicate shell command: .${name}`);
        commands.set(name, [name, command[1], command[2]]);
    };
    register(['clear', 'Clear the terminal screen', () => undefined]);
    register([
        'timer',
        'Set query timer: on or off',
        args => {
            if (args.length > 1 || (args.length === 1 && !['on', 'off'].includes(args[0]))) {
                throw new Error('usage: .timer [on|off]');
            }
            if (args.length === 1) settings.timer = args[0] === 'on';
            return `Timer: ${settings.timer ? 'on' : 'off'}`;
        },
    ]);
    register([
        'help',
        'List available dot commands',
        () => {
            const width = Math.max(...Array.from(commands.keys(), name => name.length)) + 3;
            return Array.from(commands.values(), command => `.${command[0]}`.padEnd(width) + command[1]).join('\r\n') + '\r\n';
        },
    ]);
    for (const command of extensions) register(command);
    return commands;
}

function withTrailingNewline(output: string): string {
    if (output.length === 0) return output;
    return output.replace(/(?:\r\n|\n|\r)+$/, '') + '\r\n';
}

function formatElapsed(elapsedMs: number): string {
    if (elapsedMs < 1000) return `${Math.round(elapsedMs)} ms`;
    if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(3)} s`;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const milliseconds = Math.floor(elapsedMs) % 1000;
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    const suffix = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
    return hours === 0 ? suffix : `${String(hours).padStart(2, '0')}:${suffix}`;
}

export async function createDashQLShell(options: DashQLShellOptions): Promise<DashQLShell> {
    return await DashQLShell.create(options);
}
