import * as core from '@ankoh/dashql-core';

import type { CancelQuery, QueryExecutor } from '../connections/query_executor.js';
import { QueryType } from '../connections/query_execution_state.js';
import { APPLY_PLANNER_ANALYSIS, getSortedScriptFileNames, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, resolveCompiledVisualization, SET_SCRIPT_EXECUTION_VISUALIZATION, type NotebookScripts } from './notebook_scripts.js';
import type { ModifyNotebookScripts } from './notebook_scripts_registry.js';
import { projectionForVisualizeQuery } from './script_types.js';
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const activeNotebooks = new WeakMap<core.DashQL, Set<string>>();
const PREPARATION_YIELD_INTERVAL = 8;
const EXECUTION_YIELD_INTERVAL = 8;
const DEFAULT_MAX_CONCURRENT_QUERIES = 1;

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
    /// Maximum concurrently running backend queries for this connection.
    maxConcurrentQueries?: number;
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
    const activeExecutions = new Map<number, Promise<unknown>>();
    const cancellations = new Map<number, Promise<void>>();
    const cooperate = async () => {
        signal.throwIfAborted();
        await (args.yieldToBrowser ?? yieldToBrowser)();
        signal.throwIfAborted();
    };
    const stop = () => {
        emit({ phase: 'stopping' });
        for (const queryId of activeExecutions.keys()) {
            if (cancellations.has(queryId)) continue;
            // Catch immediately: cancellation can reject before execution has drained.
            try {
                cancellations.set(queryId, args.cancelQuery(databaseId, queryId).catch(() => {}));
            } catch {
                cancellations.set(queryId, Promise.resolve());
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
        const predecessorCount = graph.nodes.map(() => 0);
        const successors = graph.nodes.map(() => [] as number[]);
        const uniqueEdges = new Set<string>();
        for (const edge of graph.edges) {
            const key = `${edge.from}:${edge.to}`;
            if (uniqueEdges.has(key)) continue;
            uniqueEdges.add(key);
            predecessorCount[edge.to]++;
            successors[edge.from].push(edge.to);
        }
        const statementIndexes = scripts.map(() => [] as number[]);
        const outputNodeIndexes = scripts.map(() => -1);
        const outputQueryIds = scripts.map(() => null as number | null);
        const previousResultQueryIds = scripts.map(script => {
            const liveScript = args.getNotebook()?.scripts[script.scriptKey];
            return liveScript?.latestResultQueryId === undefined ? liveScript?.latestQueryId : liveScript.latestResultQueryId;
        });
        const settledStatementCounts = scripts.map(() => 0);
        for (const [nodeIndex, node] of graph.nodes.entries()) {
            statementIndexes[node.script].push(nodeIndex);
            if (node.producesOutput) outputNodeIndexes[node.script] = nodeIndex;
        }
        const ready = graph.nodes.map((_node, index) => index).filter(index => predecessorCount[index] === 0);
        const maxConcurrentQueries = Math.max(1, args.maxConcurrentQueries ?? DEFAULT_MAX_CONCURRENT_QUERIES);
        const completions: Promise<void>[] = [];
        for (const statements of statementIndexes) if (statements.length === 0) {
            emit({ completedScripts: state.completedScripts + 1 });
        }
        let running = 0;
        let failure: unknown = null;
        let notify: (() => void) | null = null;
        const wait = () => new Promise<void>(resolve => { notify = resolve; });
        const wake = () => { const resolve = notify; notify = null; resolve?.(); };
        const cancelActive = () => {
            for (const queryId of activeExecutions.keys()) {
                if (cancellations.has(queryId)) continue;
                try { cancellations.set(queryId, args.cancelQuery(databaseId, queryId).catch(() => {})); }
                catch { cancellations.set(queryId, Promise.resolve()); }
            }
        };
        const launch = (nodeIndex: number) => {
            const node = graph.nodes[nodeIndex];
            const scriptIndex = node.script;
            const script = scripts[scriptIndex];
            const statementIndex = statementIndexes[scriptIndex].indexOf(nodeIndex);
            const output = outputNodeIndexes[scriptIndex] === nodeIndex;
            const visualization = visualizations.get(node) ?? null;
            const previousQueryId = previousResultQueryIds[scriptIndex];
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                running--;
                for (const successor of successors[nodeIndex]) if (--predecessorCount[successor] === 0) ready.push(successor);
                ready.sort((a, b) => a - b);
                wake();
            };
            validate(false);
            emit({ activeScriptKey: script.scriptKey, activeFileName: files[scriptIndex],
                activeStatementIndex: statementIndex + 1, activeStatementCount: statementIndexes[scriptIndex].length });
            running++;
            const [queryId, execution] = args.executeQuery(databaseId, {
                query: String(node.sql ?? ''), cacheable: false, throwOnError: true, abortSignal: signal,
                analyzeResults: output, publishResults: output, replaceComputationId: output ? previousQueryId : undefined,
                projection: output ? projectionForVisualizeQuery(visualization) : undefined, onResultsReady: release,
                metadata: { queryType: QueryType.USER_PROVIDED, title: null, description: null, issuer: null, userProvided: true },
            });
            activeExecutions.set(queryId, execution);
            args.modifyNotebookScripts({ type: REGISTER_QUERY, value: [script.scriptKey, queryId] });
            if (output) args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [script.scriptKey, visualization] });
            const completion = execution.then(async table => {
                // Executors that do not implement result readiness retain the historical behavior.
                release();
                if (output) {
                    await args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [script.scriptKey, visualization] });
                    if (table != null) await args.modifyNotebookScripts({ type: REGISTER_SCRIPT_RESULT, value: [script.scriptKey, queryId] });
                    outputQueryIds[scriptIndex] = queryId;
                }
                activeExecutions.delete(queryId);
                await cancellations.get(queryId);
                cancellations.delete(queryId);
                if (signal.aborted) {
                    wake();
                    return;
                }
                emit({ completedStatements: state.completedStatements + 1 });
                settledStatementCounts[scriptIndex]++;
                if (settledStatementCounts[scriptIndex] === statementIndexes[scriptIndex].length) {
                    emit({ completedScripts: state.completedScripts + 1 });
                }
                if (state.completedStatements % EXECUTION_YIELD_INTERVAL === 0) await cooperate();
                wake();
            }, error => {
                release();
                activeExecutions.delete(queryId);
                if (failure == null) { failure = error; cancelActive(); }
                wake();
                throw error;
            });
            completion.catch(() => {});
            completions.push(completion);
        };
        while ((ready.length > 0 || running > 0) && failure == null && !signal.aborted) {
            while (ready.length > 0 && running < maxConcurrentQueries && failure == null && !signal.aborted) launch(ready.shift()!);
            if (ready.length > 0 && running >= maxConcurrentQueries || running > 0) await wait();
        }
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (failure != null) throw failure;
        await Promise.all(completions);
        for (const [scriptIndex, script] of scripts.entries()) {
            const outputQueryId = outputQueryIds[scriptIndex];
            const outputNodeIndex = outputNodeIndexes[scriptIndex];
            const statements = statementIndexes[scriptIndex];
            if (outputQueryId !== null && outputNodeIndex !== statements[statements.length - 1]) {
                await args.modifyNotebookScripts({ type: REGISTER_QUERY, value: [script.scriptKey, outputQueryId] });
                await args.modifyNotebookScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION,
                    value: [script.scriptKey, visualizations.get(graph.nodes[outputNodeIndex]) ?? null] });
            }
        }
        signal.throwIfAborted();
        signal.removeEventListener('abort', stop);
        emit({ phase: 'succeeded', activeScriptKey: null, activeFileName: null,
            activeStatementIndex: null, activeStatementCount: null });
    } catch (error) {
        for (const queryId of activeExecutions.keys()) {
            if (cancellations.has(queryId)) continue;
            try { cancellations.set(queryId, args.cancelQuery(databaseId, queryId).catch(() => {})); }
            catch { cancellations.set(queryId, Promise.resolve()); }
        }
        await Promise.allSettled(activeExecutions.values());
        await Promise.allSettled(cancellations.values());
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        signal.removeEventListener('abort', stop);
        emit({ phase: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : error instanceof Error ? error.message : String(error) });
    } finally {
        signal.removeEventListener('abort', stop);
        active.delete(notebookId);
    }
}
