import * as shellModule from '@ankoh/dashql-shell-js';
import shellWasmUrl from '@ankoh/dashql-shell-wasm?url';
import { DashQL, DashQLCatalog, DashQLScript } from '@ankoh/dashql-core';
import * as dashql from '@ankoh/dashql-core';
import { stringifyError } from '../platform/logger/logger.js';
import { decodedContentLength } from '../utils/content_length.js';

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
    /// The output, the error message or the effect description
    text: string;
    effect: DashQLShellEffect | null;
}

interface DashQLShellEffect {
    id: bigint;
    type: DashQLShellEffectType;
    payload: string;
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
    onProgress?: (progress: DashQLShellInstantiationProgress) => void;
    wasmBinary?: Uint8Array;
    wasmUrl?: string | URL;
}

export interface DashQLShellInstantiationProgress {
    bytesLoaded: number;
    bytesTotal: number;
}

interface DashQLShellModuleCacheEntry {
    promise: Promise<void>;
    progress: DashQLShellInstantiationProgress | null;
    listeners: Set<(progress: DashQLShellInstantiationProgress) => void>;
}

const shellModuleGlobal = globalThis as typeof globalThis & {
    __dashqlShellModuleCache?: DashQLShellModuleCacheEntry;
};

/// Fetch the shell module, reporting the download progress
async function fetchShellWasm(
    wasmUrl: string,
    onProgress: (progress: DashQLShellInstantiationProgress) => void,
): Promise<ArrayBuffer> {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`failed to fetch shell Wasm: ${response.status} ${response.statusText}`);
    const bytesTotal = decodedContentLength(response);
    let bytesLoaded = 0;
    onProgress({ bytesLoaded, bytesTotal });
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            bytesLoaded += chunk.byteLength;
            onProgress({ bytesLoaded, bytesTotal });
            controller.enqueue(chunk);
        },
    }));
    return body == null ? await response.arrayBuffer() : await new Response(body).arrayBuffer();
}

/// Instantiate the wasm-bindgen shell module. It is instantiated once per page; later calls share it.
async function instantiateShellModule(options: DashQLShellOptions): Promise<void> {
    let entry = shellModuleGlobal.__dashqlShellModuleCache;
    if (entry == null) {
        const listeners = new Set<(progress: DashQLShellInstantiationProgress) => void>();
        const created: DashQLShellModuleCacheEntry = {
            progress: null,
            listeners,
            promise: Promise.resolve(),
        };
        const onProgress = (progress: DashQLShellInstantiationProgress) => {
            created.progress = progress;
            for (const listener of listeners) listener(progress);
        };
        const wasmUrl = options.wasmUrl?.toString() ?? shellWasmUrl;
        created.promise = (async () => {
            const moduleOrPath = options.wasmBinary ?? await fetchShellWasm(wasmUrl, onProgress);
            await shellModule.default({ module_or_path: moduleOrPath });
        })().catch(error => {
            if (shellModuleGlobal.__dashqlShellModuleCache === created) {
                delete shellModuleGlobal.__dashqlShellModuleCache;
            }
            throw error;
        });
        shellModuleGlobal.__dashqlShellModuleCache = created;
        entry = created;
    }
    if (options.onProgress != null) {
        entry.listeners.add(options.onProgress);
        if (entry.progress != null) options.onProgress(entry.progress);
    }
    try {
        await entry.promise;
    } finally {
        if (options.onProgress != null) entry.listeners.delete(options.onProgress);
    }
}

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
    protected shell: shellModule.Shell | null;
    protected readonly lifecycleAbort = new AbortController();
    protected activeExecution: AbortController | null = null;
    protected readonly catalogScripts: DashQLScript[] = [];
    protected readonly commands: Map<string, DashQLShellCommand>;
    protected readonly settings: DashQLShellSettings;

    protected constructor(
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
        this.shell = new shellModule.Shell(
            catalog.ptr.assertNotNull(),
            terminalColumns,
            autoQualifyNonDefaultDatabaseTables,
        );
        const status = this.shell.setCommands(Array.from(commands.keys()).join('\n')) as DashQLShellStatus;
        if (status !== DashQLShellStatus.OK) {
            this.shell.free();
            this.shell = null;
            throw new DashQLShellError(status, 'failed to configure shell commands');
        }
    }

    static async create(options: DashQLShellOptions): Promise<DashQLShell> {
        const settings: DashQLShellSettings = { timer: false };
        const commands = createShellCommands(options.commands ?? [], settings);
        await instantiateShellModule(options);
        // The shell module carries the core bindings, a shell takes catalogs of the same module
        const core = new DashQL({ ...shellModule });
        const catalog = core.createCatalog();
        const shell = new DashQLShell(
            core,
            catalog,
            options.environment,
            options.terminalColumns ?? 100,
            options.autoQualifyNonDefaultDatabaseTables ?? false,
            commands,
            settings,
        );
        if (options.trackSessionRelations) {
            const status = shell.alive().setSessionRelations(true) as DashQLShellStatus;
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
        this.alive().resize(terminalColumns);
    }

    setKeywordCase(keywordCase: dashql.buffers.formatting.KeywordCase): void {
        this.alive().setKeywordCase(keywordCase);
    }

    setPrompt(text: string): DashQLShellPrompt {
        return this.readPrompt(this.alive().setPrompt(text));
    }

    insertPrompt(text: string): DashQLShellPrompt {
        return this.readPrompt(this.alive().insertPrompt(text));
    }

    movePromptLeft(): DashQLShellPrompt {
        return this.readPrompt(this.alive().movePromptLeft());
    }

    movePromptRight(): DashQLShellPrompt {
        return this.readPrompt(this.alive().movePromptRight());
    }

    deletePromptBackward(): DashQLShellPrompt {
        return this.readPrompt(this.alive().deletePromptBackward());
    }

    deletePromptForward(): DashQLShellPrompt {
        return this.readPrompt(this.alive().deletePromptForward());
    }

    completePrompt(limit = 20): DashQLShellCompletionCandidate[] {
        const shell = this.alive();
        let candidates: shellModule.ShellCompletionCandidate[];
        try {
            candidates = shell.completePrompt(limit);
        } catch (error) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'failed to complete shell prompt');
        }
        return candidates.map(candidate => {
            try {
                return {
                    displayText: candidate.displayText,
                    completionText: candidate.completionText,
                    targetOffset: candidate.targetOffset,
                    targetLength: candidate.targetLength,
                };
            } finally {
                candidate.free();
            }
        });
    }

    applyCompletion(candidate: DashQLShellCompletionCandidate): DashQLShellPrompt {
        return this.readPrompt(this.alive().applyCompletion(
            candidate.displayText,
            candidate.completionText,
            candidate.targetOffset,
            candidate.targetLength,
        ));
    }

    consumePromptInput(key: DashQLShellPromptInput, text = ''): DashQLShellPrompt {
        return this.readPrompt(this.alive().consumePromptInput(key, text));
    }

    openTerminal(prompt = 'dashql> '): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().openTerminal(prompt));
    }

    consumeTerminalInput(key: DashQLShellPromptInput, text = ''): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().consumeTerminalInput(key, text));
    }

    finishTerminalQuery(output: string, error = false): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().finishTerminalQuery(output, error));
    }

    renderTerminalQueryProgress(message = '', advanceFrame = false): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().renderTerminalQueryProgress(message, advanceFrame));
    }

    clearTerminalQueryProgress(): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().clearTerminalQueryProgress());
    }

    renderTerminalStatus(message: string): DashQLShellTerminalOutput {
        return this.readTerminal(this.alive().renderTerminalStatus(message));
    }

    exportHistory(): Uint8Array {
        return this.alive().exportHistory();
    }

    importHistory(data: Uint8Array): void {
        const status = this.alive().importHistory(data) as DashQLShellStatus;
        if (status !== DashQLShellStatus.OK) {
            throw new DashQLShellError(status, 'failed to import shell history');
        }
    }

    async submitPrompt(
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
    ): Promise<string> {
        this.assertAlive();
        return await this.executeOperation(() => this.readOperation(this.alive().submitPrompt()), signal, onProgress, onResult);
    }

    async executeQuery(
        query: string,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
        onResult?: (queryId: number, rowCount: number) => void,
    ): Promise<string> {
        return await this.executeOperation(() => this.readOperation(this.alive().startQuery(query)), signal, onProgress, onResult);
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
                if (this.shell == null) {
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

    protected readPrompt(result: shellModule.ShellPromptResult): DashQLShellPrompt {
        try {
            const status = result.status as DashQLShellStatus;
            const message = result.message;
            if (status !== DashQLShellStatus.OK) {
                throw new DashQLShellError(status, message);
            }
            return {
                revision: result.revision,
                cursorByteOffset: result.cursorByteOffset,
                text: result.text,
                message,
                action: result.action as DashQLShellPromptAction,
            };
        } finally {
            result.free();
        }
    }

    protected readTerminal(result: shellModule.ShellTerminalResult): DashQLShellTerminalOutput {
        try {
            const status = result.status as DashQLShellStatus;
            const output = result.data;
            if (status !== DashQLShellStatus.OK) throw new DashQLShellError(status, output);
            return {
                action: result.action as DashQLShellPromptAction,
                data: output,
            };
        } finally {
            result.free();
        }
    }

    protected readOperation(operation: shellModule.ShellOperation): DashQLShellOperation {
        try {
            const status = operation.status as DashQLShellStatus;
            const effectId = operation.effectId;
            const effectType = operation.effectType;
            return {
                status,
                text: operation.text,
                effect: status === DashQLShellStatus.PENDING && effectId != null && effectType != null
                    ? { id: effectId, type: effectType as DashQLShellEffectType, payload: operation.effectPayload ?? '' }
                    : null,
            };
        } finally {
            operation.free();
        }
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

            const effectInput = effect.payload;
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

    protected completeEffect(
        effectId: bigint,
        status: DashQLShellEffectCompletionStatus,
        data: Uint8Array,
    ): DashQLShellOperation {
        return this.readOperation(this.alive().completeEffect(effectId, status, data));
    }

    protected cancelEffect(effectId: bigint): DashQLShellOperation {
        return this.readOperation(this.alive().cancelEffect(effectId));
    }

    protected requireComplete(operation: DashQLShellOperation): string {
        if (operation.status !== DashQLShellStatus.OK) {
            throw new DashQLShellError(operation.status, operation.text);
        }
        return operation.text;
    }

    protected requireEffect(operation: DashQLShellOperation): DashQLShellEffect {
        if (operation.status !== DashQLShellStatus.PENDING) {
            throw new DashQLShellError(operation.status, operation.text);
        }
        if (operation.effect == null) {
            throw new DashQLShellError(DashQLShellStatus.INTERNAL_ERROR, 'invalid shell effect envelope');
        }
        return operation.effect;
    }

    destroy(): void {
        if (this.shell != null) {
            this.lifecycleAbort.abort();
            this.shell.free();
            this.shell = null;
            for (let i = this.catalogScripts.length - 1; i >= 0; --i) {
                this.catalogScripts[i].destroy();
            }
            this.catalogScripts.length = 0;
            this.catalog.destroy();
        }
    }

    protected alive(): shellModule.Shell {
        if (this.shell == null) {
            throw new DashQLShellError(DashQLShellStatus.INVALID_ARGUMENT, 'DashQL shell has been destroyed');
        }
        return this.shell;
    }

    protected assertAlive(): void {
        this.alive();
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
