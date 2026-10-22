import * as core from '@ankoh/dashql-core';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connections/connector_info.js';
import type { CancelQuery, QueryExecutor } from '../connections/query_executor.js';
import { SessionTestBackend } from '../persistence/session_test_backend.js';
import { StorageWriter } from '../persistence/storage_writer.js';
import { runSessionExecution, type SessionExecutionState } from './session_execution.js';
import {
    APPLY_PLANNER_ANALYSIS,
    createEmptyScriptData,
    type SessionScripts,
    type SessionScriptsAction,
    reduceSessionScripts,
    REGISTER_QUERY,
    REGISTER_SCRIPT_RESULT,
    replaceScriptSessionText,
    SET_SCRIPT_EXECUTION_VISUALIZATION,
    SET_SCRIPT_TEXT,
} from './session_scripts.js';
import type { ModifySessionScripts } from './session_scripts_registry.js';
import { createEmptyMetadata, createScriptRef } from './script_types.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

let dql: core.DashQL;
const logger = new NullLogger();

beforeAll(async () => { dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }); });
afterEach(() => { vi.restoreAllMocks(); dql.resetUnsafe(); });

function fixture(entries: Array<[string, string]>) {
    const catalog = dql.createCatalog();
    const scripts: SessionScripts['scripts'] = {};
    const scriptRefs: SessionScripts['scriptRefs'] = {};
    for (const [fileName, text] of entries) {
        const [scriptKey, script] = createEmptyScriptData(dql, catalog, fileName);
        replaceScriptSessionText(script.scriptSession, text);
        scripts[scriptKey] = script;
        scriptRefs[fileName] = createScriptRef(scriptKey, fileName);
    }
    let live: SessionScripts = {
        instance: dql, sessionId: crypto.randomUUID(), name: 'Execution integration', settings: { cacheQueryResults: false },
        databaseId: crypto.randomUUID(), sessionMetadata: createEmptyMetadata(),
        connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER], connectionCatalog: catalog,
        scripts, scriptRefs, scriptFocus: { fileName: entries[0]?.[0] ?? '' }, semanticUserFocus: null,
    };
    const writer = new StorageWriter(logger, new SessionTestBackend());
    const write = vi.spyOn(writer, 'write');
    const apply = (action: SessionScriptsAction) => {
        live = reduceSessionScripts(live, action, writer, logger, true);
        return live;
    };
    const modifySessionScripts = vi.fn<ModifySessionScripts>(action => { apply(action); });
    const calls: Array<{ databaseId: string; queryId: number; sql: string }> = [];
    let nextQueryId = 0;
    const executeQuery = vi.fn<QueryExecutor>((databaseId, args) => {
        const queryId = ++nextQueryId;
        calls.push({ databaseId, queryId, sql: args.query });
        return [queryId, Promise.resolve(args.analyzeResults ? tableFromArrays({ value: [1] }) : null)];
    });
    const cancelQuery = vi.fn<CancelQuery>(async () => {});
    const states: SessionExecutionState[] = [];
    const controller = new AbortController();
    const graphs: core.buffers.execution.ExecutionGraphT[] = [];
    const nativePlan = dql.plan.bind(dql);
    const plan = vi.spyOn(dql, 'plan').mockImplementation(input => {
        const buffer = nativePlan(input);
        const unpack = buffer.unpackAndDestroy.bind(buffer);
        vi.spyOn(buffer, 'unpackAndDestroy').mockImplementation(() => {
            const graph = unpack();
            graphs.push(graph);
            return graph;
        });
        return buffer;
    });
    const run = () => runSessionExecution({
        session: live, getSession: () => live, executeQuery, cancelQuery, modifySessionScripts,
        signal: controller.signal, onState: state => { states.push(state); },
    });
    const script = (fileName: string) => live.scripts[live.scriptRefs[fileName].scriptId];
    const lastState = () => states[states.length - 1];
    return { run, apply, script, getSession: () => live, modifySessionScripts, executeQuery,
        cancelQuery, controller, calls, states, lastState, graphs, plan, write };
}

describe('session execution with real core planning', () => {
    it('executes create, insert, and select across scripts in natural order with real dependencies', async () => {
        const f = fixture([
            ['10_query.sql', 'select id from items;'],
            ['2_insert.sql', 'insert into items values (7);'],
            ['1_create.sql', 'create table items (id int);'],
        ]);
        await f.run();
        expect(f.lastState()?.error).toBeNull();

        expect(f.plan).toHaveBeenCalledExactlyOnceWith([
            f.script('1_create.sql').scriptSession,
            f.script('2_insert.sql').scriptSession,
            f.script('10_query.sql').scriptSession,
        ]);
        expect(f.calls).toEqual([
            { databaseId: f.getSession().databaseId, queryId: 1, sql: 'create table items (id int)' },
            { databaseId: f.getSession().databaseId, queryId: 2, sql: 'insert into items values (7)' },
            { databaseId: f.getSession().databaseId, queryId: 3, sql: 'select id from items' },
        ]);
        const graph = f.graphs[0];
        expect(graph.valid).toBe(true);
        expect(graph.nodes.map(node => [node.script, node.statementId, node.producesOutput]))
            .toEqual([[0, 0, false], [1, 0, false], [2, 0, true]]);
        expect(graph.entities.map(entity => entity.name)).toEqual(['items']);
        expect(graph.unresolvedReferences).toEqual([]);
        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ from: 0, to: 1, reason: core.buffers.execution.ExecutionGraphEdgeReason.DDL }),
            expect.objectContaining({ from: 1, to: 2, reason: core.buffers.execution.ExecutionGraphEdgeReason.READ_AFTER_WRITE }),
        ]));
        expect(f.lastState()).toEqual({
            phase: 'succeeded', totalScripts: 3, completedScripts: 3,
            totalStatements: 3, completedStatements: 3, activeScriptKey: null,
            activeFileName: null, activeStatementIndex: null, activeStatementCount: null, error: null,
        });
        expect(f.cancelQuery).not.toHaveBeenCalled();
    });

    it('synchronizes analysis through the reducer before backend calls and retains query registrations', async () => {
        const f = fixture([
            ['1_create.sql', 'create table items (id int);'],
            ['2_query.sql', 'select id from items;'],
        ]);
        const initial = f.getSession();
        const executor = f.executeQuery.getMockImplementation()!;
        f.executeQuery.mockImplementation((databaseId, args) => {
            expect(f.getSession()).not.toBe(initial);
            for (const script of Object.values(f.getSession().scripts)) {
                expect(script.analysisOutdated).toBe(false);
                expect(script.editorUpdate).toMatchObject({
                    status: core.buffers.editor.EditorUpdateStatus.OK, analysisAvailable: true,
                    textVersion: script.scriptSession.getTextVersion(),
                    catalogRevision: script.scriptSession.getCatalogRevision(),
                });
            }
            expect(f.script('1_create.sql').annotations.tableDefs).toEqual(['items']);
            return executor(databaseId, args);
        });
        await f.run();

        const actions = f.modifySessionScripts.mock.calls.map(([action]) => action);
        expect(actions.filter(action => action.type !== SET_SCRIPT_EXECUTION_VISUALIZATION).map(action => action.type))
            .toEqual([APPLY_PLANNER_ANALYSIS, REGISTER_QUERY, REGISTER_QUERY, REGISTER_SCRIPT_RESULT]);
        const analysis = actions[0];
        expect(analysis.type).toBe(APPLY_PLANNER_ANALYSIS);
        if (analysis.type === APPLY_PLANNER_ANALYSIS) {
            for (const { scriptKey, editorUpdate } of analysis.value) {
                expect(f.getSession().scripts[scriptKey].editorUpdate).toBe(editorUpdate);
            }
        }
        expect(f.script('1_create.sql').latestQueryId).toBe(1);
        expect(f.script('2_query.sql').latestQueryId).toBe(2);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.lastState().phase).toBe('succeeded');
    });

    it('analyzes only the last output per script and restores it after trailing commands', async () => {
        const f = fixture([
            ['1_outputs.sql', 'create table items (id int); select 1; select 2; insert into items values (3);'],
            ['2_outputs.sql', 'select id from items; select 4;'],
        ]);
        f.apply({ type: REGISTER_QUERY, value: [f.script('1_outputs.sql').scriptKey, 0] });
        f.apply({ type: REGISTER_SCRIPT_RESULT, value: [f.script('1_outputs.sql').scriptKey, 0] });
        await f.run();

        expect(f.graphs[0].nodes.map(node => node.producesOutput)).toEqual([false, true, true, false, true, true]);
        expect(f.executeQuery.mock.calls.map(([, args]) => args.analyzeResults))
            .toEqual([false, false, true, false, false, true]);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(0);
        expect(f.script('1_outputs.sql').latestQueryId).toBe(3);
        expect(f.script('2_outputs.sql').latestQueryId).toBe(6);
        expect(f.calls.map(call => call.queryId)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(f.lastState()).toMatchObject({ phase: 'succeeded', completedStatements: 6, completedScripts: 2 });
    });

    it('executes EXPLAIN as an output statement', async () => {
        const f = fixture([['1_explain.sql', 'explain select 2;']]);
        await f.run();

        expect(f.graphs[0].valid).toBe(true);
        expect(f.graphs[0].nodes[0]).toMatchObject({ producesOutput: true, visualization: null });
        expect(f.calls.map(call => call.sql)).toEqual(['explain select 2']);
        expect(f.executeQuery.mock.calls[0][1]).toMatchObject({ analyzeResults: true, publishResults: true });
        expect(f.script('1_explain.sql').annotations.visualizeQuery).toBeNull();
        expect(f.lastState().phase).toBe('succeeded');
    });

    it('lowers multiple visualizations and retains the last output after trailing DELETE', async () => {
        const f = fixture([['1_visualize.sql',
            'create table items (id int); select id from items visualize using table (); '
            + 'select 2 as value visualize using table (dashboard => (row => 2, column => 4, width => 8, height => 5)); '
            + 'delete from items;']]);
        await f.run();

        expect(f.graphs[0].valid).toBe(true);
        expect(f.calls.map(call => call.sql)).toEqual([
            'create table items (id int)', 'select id from items', 'select 2 as value', 'delete from items',
        ]);
        expect(f.executeQuery.mock.calls.map(([, args]) => args.analyzeResults)).toEqual([false, false, true, false]);
        expect(f.executeQuery.mock.calls.map(([, args]) => args.projection)).toEqual([undefined, undefined, undefined, undefined]);
        expect(f.script('1_visualize.sql')).toMatchObject({
            latestQueryId: 3, latestResultQueryId: 3,
            annotations: { visualizeQuery: { renderer: 'table', sql: 'select 2 as value',
                dashboardSpec: { row: 2, column: 4, width: 8, height: 5 } } },
        });
        const actions = f.modifySessionScripts.mock.calls.map(([action]) => action);
        const captured = actions.findIndex(action => action.type === SET_SCRIPT_EXECUTION_VISUALIZATION);
        expect(actions[captured - 1]).toEqual({ type: REGISTER_QUERY, value: [f.script('1_visualize.sql').scriptKey, 3] });
        expect(f.write).not.toHaveBeenCalled();
        expect(f.lastState().phase).toBe('succeeded');
    });

    it('uses captured UMAP projection and visualization despite live edits during execution', async () => {
        const f = fixture([['1_umap.sql',
            'create table embeddings (embedding int, other int, cluster_id int, label text); '
            + 'select embedding, cluster_id, label from embeddings visualize using umap '
            + '(vector => embedding, category => cluster_id, label => label, neighbors => 7, min_dist => 0.2, metric => euclidean);']]);
        const executor = f.executeQuery.getMockImplementation()!;
        f.executeQuery.mockImplementation((databaseId, args) => {
            const execution = executor(databaseId, args);
            if (!args.analyzeResults) {
                f.apply({ type: SET_SCRIPT_TEXT, value: { scriptKey: f.script('1_umap.sql').scriptKey,
                    text: 'select other from embeddings visualize using umap (vector => other);' } });
            } else {
                execution[1] = execution[1].then(table => {
                    f.apply({ type: SET_SCRIPT_TEXT, value: { scriptKey: f.script('1_umap.sql').scriptKey, text: 'select 9;' } });
                    return table;
                });
            }
            return execution;
        });
        await f.run();

        expect(f.calls.map(call => call.sql)).toEqual([
            'create table embeddings (embedding int, other int, cluster_id int, label text)',
            'select embedding, cluster_id, label from embeddings',
        ]);
        expect(f.executeQuery.mock.calls[0][1].projection).toBeUndefined();
        expect(f.executeQuery.mock.calls[1][1].projection).toEqual({
            vectorColumn: 'embedding', options: { metric: 'euclidean', nNeighbors: 7, minDist: 0.2 },
        });
        expect(f.script('1_umap.sql').scriptSession.getText()).toBe('select 9;');
        expect(f.script('1_umap.sql').annotations.visualizeQuery).toMatchObject({
            renderer: 'umap', sql: 'select embedding, cluster_id, label from embeddings',
            umapSpec: { vectorColumn: 'embedding', categoryColumn: 'cluster_id', labelColumn: 'label',
                projection: { metric: 'euclidean', neighbors: 7, minDist: 0.2 } },
        });
        expect(f.lastState().phase).toBe('succeeded');
    });

    it('clears live visualization metadata when the captured output is not VISUALIZE', async () => {
        const f = fixture([['1_query.sql', 'create table items (id int); select 1;']]);
        const executor = f.executeQuery.getMockImplementation()!;
        f.executeQuery.mockImplementation((databaseId, args) => {
            if (!args.analyzeResults) {
                f.apply({ type: SET_SCRIPT_TEXT, value: { scriptKey: f.script('1_query.sql').scriptKey,
                    text: 'select 2 visualize using table ();' } });
                expect(f.script('1_query.sql').annotations.visualizeQuery?.renderer).toBe('table');
            }
            return executor(databaseId, args);
        });
        await f.run();

        expect(f.calls.map(call => call.sql)).toEqual(['create table items (id int)', 'select 1']);
        expect(f.script('1_query.sql').annotations.visualizeQuery).toBeNull();
        expect(f.lastState().phase).toBe('succeeded');
    });

    it('changes only the visualization annotation without analysis, catalog publication, or storage', () => {
        const f = fixture([['1_query.sql', 'select 1;']]);
        const previous = f.script('1_query.sql');
        const analyze = vi.spyOn(previous.scriptSession, 'analyze');
        const publish = vi.spyOn(previous.scriptSession, 'loadIntoCatalog');
        const visualization = { renderer: 'table' as const, sql: 'select 1' };
        f.apply({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [previous.scriptKey, visualization] });

        const next = f.script('1_query.sql');
        expect(next).toEqual({ ...previous, annotations: { ...previous.annotations, visualizeQuery: visualization } });
        expect(next.annotations.visualizeQuery).toBe(visualization);
        expect(next.annotations.tableDefs).toBe(previous.annotations.tableDefs);
        expect(analyze).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
        f.apply({ type: SET_SCRIPT_EXECUTION_VISUALIZATION, value: [previous.scriptKey, null] });
        expect(f.script('1_query.sql').annotations.visualizeQuery).toBeNull();
    });

    it('rejects malformed captured metadata on an earlier output before any backend call', async () => {
        const f = fixture([['1_query.sql',
            'create table items (id int); select 1 visualize using table (); select 2;']]);
        const planner = f.plan.getMockImplementation()!;
        f.plan.mockImplementation(input => {
            const buffer = planner(input);
            const unpack = vi.mocked(buffer.unpackAndDestroy).getMockImplementation()!;
            vi.mocked(buffer.unpackAndDestroy).mockImplementation(() => {
                const graph = unpack();
                graph.nodes[1].visualization!.renderer = 'vegalite';
                graph.nodes[1].visualization!.vegaliteSpec = '{';
                return graph;
            });
            return buffer;
        });
        await f.run();

        expect(f.graphs[0].valid).toBe(true);
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.modifySessionScripts).not.toHaveBeenCalled();
        expect(f.lastState()).toMatchObject({ phase: 'failed', completedStatements: 0,
            error: 'Invalid captured visualization metadata' });
    });

    it('rejects an unsupported SET plan without executing even preceding valid SQL', async () => {
        const f = fixture([
            ['1_valid.sql', 'select 1;'],
            ['2_set.sql', 'set foo = 1;'],
        ]);
        await f.run();

        expect(f.graphs).toHaveLength(1);
        expect(f.graphs[0].valid).toBe(false);
        expect(f.graphs[0].diagnostics.length).toBeGreaterThan(0);
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.modifySessionScripts).not.toHaveBeenCalled();
        expect(f.lastState()).toMatchObject({ phase: 'failed', completedStatements: 0 });
        expect(f.lastState().error).toBeTruthy();
    });

    it('plans again from edited live sessions on rerun rather than reusing captured SQL', async () => {
        const f = fixture([['1_query.sql', 'select 1;']]);
        await f.run();
        const previousVersion = f.graphs[0].scripts[0].textVersion;
        f.apply({ type: SET_SCRIPT_TEXT, value: { scriptKey: f.script('1_query.sql').scriptKey, text: 'select 2; select 3;' } });
        await f.run();

        expect(f.plan).toHaveBeenCalledTimes(2);
        expect(f.graphs).toHaveLength(2);
        expect(f.graphs[1].scripts[0].textVersion).not.toBe(previousVersion);
        expect(f.graphs[1].scripts[0].textVersion).toBe(f.script('1_query.sql').scriptSession.getTextVersion());
        expect(f.calls.map(call => call.sql)).toEqual(['select 1', 'select 2', 'select 3']);
        expect(f.executeQuery.mock.calls.map(([, args]) => args.analyzeResults)).toEqual([true, false, true]);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(1);
        expect(f.script('1_query.sql').latestQueryId).toBe(3);
        expect(f.lastState()).toMatchObject({ phase: 'succeeded', totalStatements: 2, completedStatements: 2 });
    });

    it('invalidates a plan when live text changes during APPLY_PLANNER_ANALYSIS synchronization', async () => {
        const f = fixture([['1_query.sql', 'select 1;']]);
        f.modifySessionScripts.mockImplementationOnce(async action => {
            expect(action.type).toBe(APPLY_PLANNER_ANALYSIS);
            f.apply(action);
            await Promise.resolve();
            f.apply({ type: SET_SCRIPT_TEXT, value: { scriptKey: f.script('1_query.sql').scriptKey, text: 'select 2;' } });
            return f.getSession();
        });
        await f.run();

        expect(f.graphs[0].valid).toBe(true);
        expect(f.graphs[0].scripts[0].textVersion).not.toBe(f.script('1_query.sql').scriptSession.getTextVersion());
        expect(f.script('1_query.sql').scriptSession.getText()).toBe('select 2;');
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.script('1_query.sql').latestQueryId).toBeNull();
        expect(f.lastState()).toMatchObject({ phase: 'failed', completedStatements: 0, completedScripts: 0 });
        expect(f.lastState().error).toMatch(/stale execution plan|session changed while planning/i);
    });
});
