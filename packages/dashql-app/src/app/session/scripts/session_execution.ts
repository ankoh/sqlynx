import * as core from '@ankoh/dashql-core';

import type { CancelQuery, QueryExecutor } from '../../connections/query_executor.js';
import { QueryType } from '../../../query/query_execution_state.js';
import { APPLY_PLANNER_ANALYSIS, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, SET_SCRIPT_EXECUTION_VISUALIZATION, type ScriptData, type SessionScripts } from './session_scripts.js';
import { resolveCompiledVisualization } from './script_compilation.js';
import type { ModifySessionScripts } from './session_scripts_registry.js';
import { projectionForVisualizeQuery } from './script_types.js';
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const activeSessions = new WeakMap<core.DashQL, Set<string>>();
const PREPARATION_YIELD_INTERVAL = 8;
const EXECUTION_YIELD_INTERVAL = 8;
const DEFAULT_MAX_CONCURRENT_QUERIES = 1;

export function isSessionExecutionRunning(session: SessionScripts): boolean {
    return activeSessions.get(session.instance)?.has(session.sessionId) ?? false;
}

export interface SessionExecutionState {
    phase: 'planning' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
    totalScripts: number;
    completedScripts: number;
    /// The statements of the blocks that were planned so far
    totalStatements: number;
    completedStatements: number;
    /// The number of blocks, runs of consecutive scripts on the same connection
    totalBlocks: number;
    /// The number of finished blocks
    completedBlocks: number;
    /// The connection of the running block
    activeConnectionId: string | null;
    activeScriptKey: number | null;
    activeFileName: string | null;
    activeStatementIndex: number | null;
    activeStatementCount: number | null;
    error: string | null;
}

/// Consecutive scripts of a session that run on the same connection.
///
/// The planner only orders the statements of scripts that share a catalog. Blocks run one after
/// another in feed order, the statements of a block run in the order of its plan.
export interface ExecutionBlock {
    /// The connection the scripts run on
    connectionId: string;
    /// The positions of the scripts in the feed
    scriptIndexes: number[];
}

/// Group the scripts in feed order into blocks of consecutive scripts on the same connection
export function planExecutionBlocks(scripts: readonly ScriptData[]): ExecutionBlock[] {
    const blocks: ExecutionBlock[] = [];
    for (const [index, script] of scripts.entries()) {
        const last = blocks[blocks.length - 1];
        if (last != null && last.connectionId === script.connection.connectionId) {
            last.scriptIndexes.push(index);
        } else {
            blocks.push({ connectionId: script.connection.connectionId, scriptIndexes: [index] });
        }
    }
    return blocks;
}

export async function runSessionExecution(args: {
    session: SessionScripts;
    getSession: () => SessionScripts | null;
    executeQuery: QueryExecutor;
    cancelQuery: CancelQuery;
    modifySessionScripts: ModifySessionScripts;
    signal: AbortSignal;
    onState: (state: SessionExecutionState) => void;
    /// Allows tests to control cooperative scheduling without relying on timer timing.
    yieldToBrowser?: () => Promise<void>;
    /// Maximum concurrently running backend queries on a connection.
    maxConcurrentQueries?: (connectionId: string) => number;
}): Promise<void> {
    const { session, signal } = args;
    const { sessionId, instance } = session;
    if (isSessionExecutionRunning(session)) return;
    let active = activeSessions.get(instance);
    if (!active) activeSessions.set(instance, active = new Set());
    active.add(sessionId);
    let state: SessionExecutionState = {
        phase: 'planning', totalScripts: 0, completedScripts: 0,
        totalStatements: 0, completedStatements: 0,
        totalBlocks: 0, completedBlocks: 0, activeConnectionId: null,
        activeScriptKey: null, activeFileName: null,
        activeStatementIndex: null, activeStatementCount: null, error: null,
    };
    const emit = (update: Partial<SessionExecutionState>) => {
        state = { ...state, ...update };
        args.onState(state);
    };
    /// The running queries with their connections
    const activeExecutions = new Map<number, { connectionId: string; execution: Promise<unknown> }>();
    const cancellations = new Map<number, Promise<void>>();
    const cooperate = async () => {
        signal.throwIfAborted();
        await (args.yieldToBrowser ?? yieldToBrowser)();
        signal.throwIfAborted();
    };
    const cancelActive = () => {
        for (const [queryId, { connectionId }] of activeExecutions) {
            if (cancellations.has(queryId)) continue;
            // Catch immediately: cancellation can reject before execution has drained.
            try {
                cancellations.set(queryId, args.cancelQuery(connectionId, queryId).catch(() => {}));
            } catch {
                cancellations.set(queryId, Promise.resolve());
            }
        }
    };
    const stop = () => {
        emit({ phase: 'stopping' });
        cancelActive();
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
        const files = [...session.scriptOrder];
        emit({ totalScripts: files.length });
        // Let React commit the running state and the browser paint its spinner before synchronous
        // analysis and planning work starts.
        await cooperate();
        const scripts = files.map(file => {
            const script = session.scripts[session.scriptRefs[file].scriptId];
            if (!script) throw new Error(`Missing script: ${file}`);
            return script;
        });
        const blocks = planExecutionBlocks(scripts);
        emit({ totalBlocks: blocks.length });
        const analyze = (script: typeof scripts[number]) => {
            const update = script.scriptSession.analyze();
            if (update.status !== core.buffers.editor.EditorUpdateStatus.OK || !update.analysisAvailable) {
                throw new Error(String(update.statusMessage || `Failed to analyze ${script.fileName}`));
            }
            return update;
        };
        // Publish all declarations into the catalogs of their connections
        for (const [index, script] of scripts.entries()) {
            analyze(script);
            script.scriptSession.loadIntoCatalog(script.scriptKey);
            if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
        }
        // The session must keep its scripts, their order and their connections for the whole run
        const validateSession = () => {
            const live = args.getSession();
            if (!live || live.sessionId !== sessionId || live.instance !== instance
                || live.scriptOrder.join('\0') !== files.join('\0') || files.some(file => live.scriptRefs[file] == null)) {
                throw new Error('Session changed during execution');
            }
            scripts.forEach((script, index) => {
                if (live.scriptRefs[files[index]].scriptId !== script.scriptKey
                    || live.scripts[script.scriptKey]?.scriptSession !== script.scriptSession) {
                    throw new Error(`Session script changed during execution: ${files[index]}`);
                }
            });
        };
        /// Plan the scripts of a block against the catalog of its connection and run them
        const runBlock = async (block: ExecutionBlock) => {
            const { connectionId } = block;
            const blockScripts = block.scriptIndexes.map(index => scripts[index]);
            const blockFiles = block.scriptIndexes.map(index => files[index]);
            emit({ activeConnectionId: connectionId });
            // Earlier blocks changed catalogs, refresh the analysis at the current catalog revision
            const updates = [] as Array<{ scriptKey: number; editorUpdate: ReturnType<typeof analyze> }>;
            for (const [index, script] of blockScripts.entries()) {
                updates.push({ scriptKey: script.scriptKey, editorUpdate: analyze(script) });
                if ((index + 1) % PREPARATION_YIELD_INTERVAL === 0) await cooperate();
            }
            await cooperate();
            const graph: core.buffers.execution.ExecutionGraphT = instance
                .plan(blockScripts.map(script => script.scriptSession)).unpackAndDestroy();
            if (!graph.valid) {
                throw new Error(graph.diagnostics.map(diagnostic => String(diagnostic.message ?? '')).join('; ')
                    || 'Invalid session execution plan');
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
            emit({ phase: 'running', totalStatements: state.totalStatements + graph.nodes.length });

            // Validate after notifications, but before the first backend call. Later edits belong to the next run.
            const validate = (checkVersions = true) => {
                validateSession();
                if (graph.scripts.length !== blockScripts.length) {
                    throw new Error('Session changed during execution');
                }
                if (!checkVersions) return;
                blockScripts.forEach((script, index) => {
                    const metadata = graph.scripts[index];
                    const scriptSession = script.scriptSession;
                    if (metadata.scriptId !== scriptSession.getCatalogEntryId()
                        || metadata.textVersion !== scriptSession.getTextVersion()
                        || metadata.analyzedTextVersion !== metadata.textVersion
                        || metadata.analyzedCatalogRevision !== scriptSession.getCatalogRevision()) {
                        throw new Error(`Stale execution plan: ${blockFiles[index]}`);
                    }
                });
            };
            validate();
            if (graph.nodes.some((node, index) => node.script >= blockScripts.length
                || (index > 0 && (node.script < graph.nodes[index - 1].script
                    || (node.script === graph.nodes[index - 1].script
                        && node.statementId <= graph.nodes[index - 1].statementId))))
                || graph.edges.some(edge => edge.from >= edge.to || edge.to >= graph.nodes.length)) {
                throw new Error('Execution plan is not in committed statement order');
            }
            signal.throwIfAborted();
            await args.modifySessionScripts({ type: APPLY_PLANNER_ANALYSIS, value: updates });
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
            const statementIndexes = blockScripts.map(() => [] as number[]);
            const outputNodeIndexes = blockScripts.map(() => -1);
            const outputQueryIds = blockScripts.map(() => null as number | null);
            const previousResultQueryIds = blockScripts.map(script => {
                const liveScript = args.getSession()?.scripts[script.scriptKey];
                return liveScript?.latestResultQueryId === undefined ? liveScript?.latestQueryId : liveScript.latestResultQueryId;
            });
            const settledStatementCounts = blockScripts.map(() => 0);
            for (const [nodeIndex, node] of graph.nodes.entries()) {
                statementIndexes[node.script].push(nodeIndex);
                if (node.producesOutput) outputNodeIndexes[node.script] = nodeIndex;
            }
            const ready = graph.nodes.map((_node, index) => index).filter(index => predecessorCount[index] === 0);
            const maxConcurrentQueries = Math.max(1, args.maxConcurrentQueries?.(connectionId) ?? DEFAULT_MAX_CONCURRENT_QUERIES);
            const completions: Promise<void>[] = [];
            for (const statements of statementIndexes) if (statements.length === 0) {
                emit({ completedScripts: state.completedScripts + 1 });
            }
            let running = 0;
            let failure: unknown = null;
            let notify: (() => void) | null = null;
            const wait = () => new Promise<void>(resolve => { notify = resolve; });
            const wake = () => { const resolve = notify; notify = null; resolve?.(); };
            const launch = (nodeIndex: number) => {
                const node = graph.nodes[nodeIndex];
                const scriptIndex = node.script;
                const script = blockScripts[scriptIndex];
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
                emit({ activeScriptKey: script.scriptKey, activeFileName: blockFiles[scriptIndex],
                    activeStatementIndex: statementIndex + 1, activeStatementCount: statementIndexes[scriptIndex].length });
                running++;
                const [queryId, execution] = args.executeQuery(connectionId, {
                    query: String(node.sql ?? ''), cacheable: false, throwOnError: true, abortSignal: signal,
                    analyzeResults: output, publishResults: output, replaceComputationId: output ? previousQueryId : undefined,
                    projection: output ? projectionForVisualizeQuery(visualization) : undefined, onResultsReady: release,
                    metadata: { queryType: QueryType.USER_PROVIDED, title: null, description: null, issuer: null, userProvided: true, sessionId },
                });
                activeExecutions.set(queryId, { connectionId, execution });
                args.modifySessionScripts({ type: REGISTER_QUERY, value: [script.scriptKey, queryId] });
                if (output) args.modifySessionScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [script.scriptKey, visualization] });
                const completion = execution.then(async table => {
                    // Executors that do not implement result readiness retain the historical behavior.
                    release();
                    if (output) {
                        await args.modifySessionScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [script.scriptKey, visualization] });
                        if (table != null) await args.modifySessionScripts({ type: REGISTER_SCRIPT_RESULT, value: [script.scriptKey, queryId] });
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
            for (const [scriptIndex, script] of blockScripts.entries()) {
                const outputQueryId = outputQueryIds[scriptIndex];
                const outputNodeIndex = outputNodeIndexes[scriptIndex];
                const statements = statementIndexes[scriptIndex];
                if (outputQueryId !== null && outputNodeIndex !== statements[statements.length - 1]) {
                    await args.modifySessionScripts({ type: REGISTER_QUERY, value: [script.scriptKey, outputQueryId] });
                    await args.modifySessionScripts({ type: SET_SCRIPT_EXECUTION_VISUALIZATION,
                        value: [script.scriptKey, visualizations.get(graph.nodes[outputNodeIndex]) ?? null] });
                }
            }
        };
        for (const block of blocks) {
            await runBlock(block);
            emit({ completedBlocks: state.completedBlocks + 1 });
        }
        signal.throwIfAborted();
        signal.removeEventListener('abort', stop);
        emit({ phase: 'succeeded', activeConnectionId: null, activeScriptKey: null, activeFileName: null,
            activeStatementIndex: null, activeStatementCount: null });
    } catch (error) {
        cancelActive();
        await Promise.allSettled([...activeExecutions.values()].map(({ execution }) => execution));
        await Promise.allSettled(cancellations.values());
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        signal.removeEventListener('abort', stop);
        emit({ phase: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : error instanceof Error ? error.message : String(error) });
    } finally {
        signal.removeEventListener('abort', stop);
        active.delete(sessionId);
    }
}
