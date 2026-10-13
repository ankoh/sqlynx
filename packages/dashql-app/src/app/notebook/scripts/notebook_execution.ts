import * as core from '@ankoh/dashql-core';

import type { CancelQuery, QueryExecutor } from '../connections/query_executor.js';
import { QueryType } from '../connections/query_execution_state.js';
import { APPLY_PLANNER_ANALYSIS, getSortedScriptFileNames, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, resolveCompiledVisualization, SET_SCRIPT_EXECUTION_VISUALIZATION, type NotebookScripts } from './notebook_scripts.js';
import type { ModifyNotebookScripts } from './notebook_scripts_registry.js';
import { projectionForVisualizeQuery } from './script_types.js';

const activeNotebooks = new WeakMap<core.DashQL, Set<string>>();
const PREPARATION_YIELD_INTERVAL = 8;
const EXECUTION_YIELD_INTERVAL = 8;

function yieldToBrowser(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export function isNotebookExecutionRunning(notebook: NotebookScripts): boolean {
    return activeNotebooks.get(notebook.instance)?.has(notebook.notebookId) ?? false;
}

export interface NotebookExecutionState {
    phase: 'planning' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
    totalScripts: number;
    completedScripts: number;
    totalStatements: number;
    completedStatements: number;
    activeScriptKey: number | null;
    activeFileName: string | null;
    activeStatementIndex: number | null;
    activeStatementCount: number | null;
    error: string | null;
}

export async function runNotebookExecution(args: {
    notebook: NotebookScripts;
    getNotebook: () => NotebookScripts | null;
    executeQuery: QueryExecutor;
    cancelQuery: CancelQuery;
    modifyNotebookScripts: ModifyNotebookScripts;
    signal: AbortSignal;
    onState: (state: NotebookExecutionState) => void;
    /// Allows tests to control cooperative scheduling without relying on timer timing.
    yieldToBrowser?: () => Promise<void>;
}): Promise<void> {
    const { notebook, signal } = args;
    const { databaseId, notebookId, instance, connectionCatalog } = notebook;
    if (isNotebookExecutionRunning(notebook)) return;
    let active = activeNotebooks.get(instance);
    if (!active) activeNotebooks.set(instance, active = new Set());
    active.add(notebookId);
    let state: NotebookExecutionState = {
        phase: 'planning', totalScripts: 0, completedScripts: 0,
        totalStatements: 0, completedStatements: 0,
        activeScriptKey: null, activeFileName: null,
        activeStatementIndex: null, activeStatementCount: null, error: null,
    };
    const emit = (update: Partial<NotebookExecutionState>) => {
        state = { ...state, ...update };
        args.onState(state);
    };
    let activeQueryId: number | null = null;
    let activeExecution: Promise<unknown> | null = null;
    let cancellation: Promise<void> | null = null;
    const cooperate = async () => {
        signal.throwIfAborted();
        await (args.yieldToBrowser ?? yieldToBrowser)();
        signal.throwIfAborted();
    };
    const stop = () => {
        emit({ phase: 'stopping' });
        if (activeQueryId !== null && cancellation === null) {
            // Catch immediately: cancellation can reject before execution has drained.
            try {
                cancellation = args.cancelQuery(databaseId, activeQueryId).catch(() => {});
            } catch {
                cancellation = Promise.resolve();
            }
        }
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
        const files = getSortedScriptFileNames(notebook.scriptRefs);
        emit({ totalScripts: files.length });
        // Let React commit the running state and the browser paint its spinner before synchronous
        // analysis and planning work starts.
        await cooperate();
        const scripts = files.map(file => {
            const script = notebook.scripts[notebook.scriptRefs[file].scriptId];
            if (!script) throw new Error(`Missing script: ${file}`);
            return script;
        });
        const analyze = (script: typeof scripts[number]) => {
            const update = script.scriptSession.analyze();
            if (update.status !== core.buffers.editor.EditorUpdateStatus.OK || !update.analysisAvailable) {
                throw new Error(String(update.statusMessage || `Failed to analyze ${script.fileName}`));
            }
            return update;
        };
        // Publish all declarations, then refresh analysis at the final catalog revision.
        for (const [index, script] of scripts.entries()) {
            analyze(script);
            script.scriptSession.loadIntoCatalog(script.scriptKey);
            if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
        }
        const updates = [] as Array<{ scriptKey: number; editorUpdate: ReturnType<typeof analyze> }>;
        for (const [index, script] of scripts.entries()) {
            updates.push({ scriptKey: script.scriptKey, editorUpdate: analyze(script) });
            if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
        }
        await cooperate();
        const graph: core.buffers.execution.ExecutionGraphT = instance
            .plan(scripts.map(script => script.scriptSession)).unpackAndDestroy();
        if (!graph.valid) {
            throw new Error(graph.diagnostics.map(diagnostic => String(diagnostic.message ?? '')).join('; ')
                || 'Invalid notebook execution plan');
        }
        const nodes = scripts.map(() => [] as typeof graph.nodes);
        for (const [index, node] of graph.nodes.entries()) {
            if (node.script < scripts.length) nodes[node.script].push(node);
            if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
        }
        // Decode every output before executing commands, including outputs we will discard.
        const visualizations = new Map<typeof graph.nodes[number], ReturnType<typeof resolveCompiledVisualization>>();
        for (const [index, node] of graph.nodes.entries()) {
            if (!node.producesOutput) continue;
            const visualization = node.visualization
                ? resolveCompiledVisualization(String(node.sql ?? ''), node.visualization) : null;
            if (node.visualization && !visualization) {
                throw new Error('Invalid captured visualization metadata');
            }
            visualizations.set(node, visualization);
            if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
        }
        emit({ phase: 'running', totalStatements: graph.nodes.length });

        // Validate after notifications, but before the first backend call. Later edits belong to the next run.
        const validate = (checkVersions = true) => {
            const live = args.getNotebook();
            if (!live || live.notebookId !== notebookId || live.databaseId !== databaseId
                || live.instance !== instance || live.connectionCatalog !== connectionCatalog
                || graph.scripts.length !== scripts.length
                || getSortedScriptFileNames(live.scriptRefs).join('\0') !== files.join('\0')) {
                throw new Error('Notebook changed during execution');
            }
            scripts.forEach((script, index) => {
                const metadata = graph.scripts[index];
                const session = script.scriptSession;
                if (live.scriptRefs[files[index]].scriptId !== script.scriptKey
                    || live.scripts[script.scriptKey]?.scriptSession !== session) {
                    throw new Error(`Notebook script changed during execution: ${files[index]}`);
                }
                if (checkVersions && (metadata.scriptId !== session.getCatalogEntryId()
                    || metadata.textVersion !== session.getTextVersion()
                    || metadata.analyzedTextVersion !== metadata.textVersion
                    || metadata.analyzedCatalogRevision !== session.getCatalogRevision())) {
                    throw new Error(`Stale execution plan: ${files[index]}`);
                }
            });
        };
        validate();
        if (graph.nodes.some((node, index) => node.script >= scripts.length
            || (index > 0 && (node.script < graph.nodes[index - 1].script
                || (node.script === graph.nodes[index - 1].script
                    && node.statementId <= graph.nodes[index - 1].statementId))))
            || graph.edges.some(edge => edge.from >= edge.to || edge.to >= graph.nodes.length)) {
            throw new Error('Execution plan is not in committed statement order');
        }
        signal.throwIfAborted();
        await args.modifyNotebookScripts({ type: APPLY_PLANNER_ANALYSIS, value: updates });
        signal.throwIfAborted();
        validate();
        for (const [scriptIndex, script] of scripts.entries()) {
            const statements = nodes[scriptIndex];
            let outputIndex = -1;
            statements.forEach((node, index) => { if (node.producesOutput) outputIndex = index; });
            let outputQueryId: number | null = null;
            const liveScript = args.getNotebook()?.scripts[script.scriptKey];
            const previousQueryId = liveScript?.latestResultQueryId === undefined
                ? liveScript?.latestQueryId : liveScript.latestResultQueryId;
            for (const [index, node] of statements.entries()) {
                signal.throwIfAborted();
                validate(false);
                emit({ activeScriptKey: script.scriptKey, activeFileName: files[scriptIndex],
                    activeStatementIndex: index + 1, activeStatementCount: statements.length });
                signal.throwIfAborted();
                const output = index === outputIndex;
                const visualization = visualizations.get(node) ?? null;
                const [queryId, execution] = args.executeQuery(databaseId, {
                    query: String(node.sql ?? ''), cacheable: false, throwOnError: true,
                    abortSignal: signal, analyzeResults: output, publishResults: output,
                    replaceComputationId: output ? previousQueryId : undefined,
                    projection: output ? projectionForVisualizeQuery(visualization) : undefined,
                    metadata: { queryType: QueryType.USER_PROVIDED, title: null, description: null,
                        issuer: null, userProvided: true },
                });
                activeQueryId = queryId;
                activeExecution = execution;
                execution.catch(() => {});
                if (signal.aborted) stop();
                try {
                    args.modifyNotebookScripts({ type: REGISTER_QUERY, value: [script.scriptKey, queryId] });
                    if (output) {
                        args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION,
                            value: [script.scriptKey, visualization] });
                    }
                    const table = await execution;
                    if (output) {
                        // Edits while the backend was running must not relabel the captured result.
                        await args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION,
                            value: [script.scriptKey, visualization] });
                    }
                    if (output && table != null) {
                        await args.modifyNotebookScripts({ type: REGISTER_SCRIPT_RESULT, value: [script.scriptKey, queryId] });
                    }
                    if (output) outputQueryId = queryId;
                } finally {
                    await Promise.allSettled([execution]);
                    if (cancellation) await cancellation;
                    activeQueryId = null;
                    activeExecution = null;
                    cancellation = null;
                }
                signal.throwIfAborted();
                emit({ completedStatements: state.completedStatements + 1 });
                // A sequence of immediately resolved commands otherwise monopolizes the microtask
                // queue and prevents status updates and animations from painting.
                if (state.completedStatements % EXECUTION_YIELD_INTERVAL === 0) await cooperate();
            }
            signal.throwIfAborted();
            if (outputQueryId !== null && outputIndex < statements.length - 1) {
                await args.modifyNotebookScripts({ type: REGISTER_QUERY, value: [script.scriptKey, outputQueryId] });
                signal.throwIfAborted();
                await args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION,
                    value: [script.scriptKey, visualizations.get(statements[outputIndex]) ?? null] });
                signal.throwIfAborted();
            }
            emit({ completedScripts: state.completedScripts + 1 });
        }
        signal.throwIfAborted();
        signal.removeEventListener('abort', stop);
        emit({ phase: 'succeeded', activeScriptKey: null, activeFileName: null,
            activeStatementIndex: null, activeStatementCount: null });
    } catch (error) {
        if (activeExecution) await Promise.allSettled([activeExecution]);
        if (cancellation) await cancellation;
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        signal.removeEventListener('abort', stop);
        emit({ phase: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : error instanceof Error ? error.message : String(error) });
    } finally {
        signal.removeEventListener('abort', stop);
        active.delete(notebookId);
    }
}
