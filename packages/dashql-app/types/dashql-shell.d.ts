// The wasm-bindgen module of the Rust shell (//packages/dashql-shell-wasm:dashql_shell_bindgen).
// It re-exports the core bindings, so `DashQL` can be created on it.
declare module '@ankoh/dashql-shell-js' {
    import type { DashQLBindings } from '@ankoh/dashql-core';

    type CatalogObject = InstanceType<DashQLBindings['Catalog']>;

    export class ShellPromptResult {
        private constructor();
        free(): void;
        readonly status: number;
        readonly revision: bigint;
        readonly cursorByteOffset: number;
        readonly text: string;
        readonly message: string;
        readonly action: number;
    }
    export class ShellTerminalResult {
        private constructor();
        free(): void;
        readonly status: number;
        readonly action: number;
        readonly data: string;
    }
    export class ShellOperation {
        private constructor();
        free(): void;
        readonly status: number;
        readonly data: Uint8Array;
        readonly text: string;
        readonly effectType: number | undefined;
        readonly effectId: bigint | undefined;
        readonly effectPayload: string | undefined;
    }
    export class ShellCompletionCandidate {
        private constructor();
        free(): void;
        readonly displayText: string;
        readonly completionText: string;
        readonly targetOffset: number;
        readonly targetLength: number;
    }
    export class Shell {
        constructor(catalog: CatalogObject, terminalColumns: number, autoQualifyNonDefaultDatabaseTables: boolean);
        free(): void;
        resize(terminalColumns: number): void;
        setKeywordCase(keywordCase: number): void;
        setSessionRelations(enabled: boolean): number;
        setCommands(commands: string): number;
        setPrompt(text: string): ShellPromptResult;
        insertPrompt(text: string): ShellPromptResult;
        movePromptLeft(): ShellPromptResult;
        movePromptRight(): ShellPromptResult;
        deletePromptBackward(): ShellPromptResult;
        deletePromptForward(): ShellPromptResult;
        completePrompt(limit: number): ShellCompletionCandidate[];
        applyCompletion(displayText: string, completionText: string, targetOffset: number, targetLength: number): ShellPromptResult;
        consumePromptInput(key: number, text: string): ShellPromptResult;
        submitPrompt(): ShellOperation;
        openTerminal(prompt: string): ShellTerminalResult;
        consumeTerminalInput(key: number, text: string): ShellTerminalResult;
        finishTerminalQuery(output: string, error: boolean): ShellTerminalResult;
        renderTerminalQueryProgress(message: string, advanceFrame: boolean): ShellTerminalResult;
        clearTerminalQueryProgress(): ShellTerminalResult;
        renderTerminalStatus(message: string): ShellTerminalResult;
        exportHistory(): Uint8Array;
        importHistory(data: Uint8Array): number;
        startQuery(query: string): ShellOperation;
        completeEffect(effectId: bigint, completionStatus: number, data: Uint8Array): ShellOperation;
        cancelEffect(effectId: bigint): ShellOperation;
    }

    export const Catalog: DashQLBindings['Catalog'];
    export const Script: DashQLBindings['Script'];
    export const ScriptBatch: DashQLBindings['ScriptBatch'];
    export const ScriptSession: DashQLBindings['ScriptSession'];
    export const ScriptExecution: DashQLBindings['ScriptExecution'];
    export const SessionList: DashQLBindings['SessionList'];
    export const PlanViewModel: DashQLBindings['PlanViewModel'];
    export const plan: DashQLBindings['plan'];
    export const processBatch: DashQLBindings['processBatch'];
    export const parseVegaLiteToVisualize: DashQLBindings['parseVegaLiteToVisualize'];
    export const appendCatalogChangesSql: DashQLBindings['appendCatalogChangesSql'];
    export const qualifyCatalogChanges: DashQLBindings['qualifyCatalogChanges'];

    export default function init(options?: { module_or_path?: BufferSource | WebAssembly.Module | string | URL | Response }): Promise<unknown>;
}

declare module '@ankoh/dashql-shell-wasm?url' {
    const value: string;
    export default value;
}
