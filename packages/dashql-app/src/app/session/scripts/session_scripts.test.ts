import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType } from '../../connections/connector_info.js';
import { SessionTestBackend } from '../../storage/session_test_backend.js';
import { StorageWriter, WRITE_SESSION_PROPERTIES, WRITE_SESSION_SCRIPTS, type StorageWriteTaskVariant } from '../../storage/storage_writer.js';
import {
    ANALYZE_OUTDATED_SCRIPT,
    CATALOG_DID_UPDATE,
    CREATE_SCRIPT,
    DELETE_SCRIPT,
    defaultScriptConnection,
    type ScriptConnection,
    SET_SCRIPT_CONNECTION,
    sessionScriptsMatchStorageSnapshot,
    type SessionScripts,
    reduceSessionScripts,
    RENAME_SCRIPT,
    RENAME_SESSION,
    UPDATE_FROM_PROCESSOR,
    UPDATE_SESSION_SETTINGS,
    REORDER_SCRIPTS,
    replaceSessionScriptsFromStorage,
    replaceScriptSessionText,
} from './session_scripts.js';
import { compileSessionQuery } from './script_compilation.js';
import { runSessionScript } from '../ui/rerun_query.js';
import { createEmptyAnnotations, createEmptyMetadata, createScriptRef } from './script_types.js';
import { createDefaultSessionSettings, readSessionSettings } from './session_settings.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

class RecordingWriter extends StorageWriter {
    readonly records: StorageWriteTaskVariant[] = [];
    override async write(_key: string, task: StorageWriteTaskVariant): Promise<boolean> {
        this.records.push(task);
        return true;
    }
}

let dql: core.DashQL;
const logger = new NullLogger();

beforeAll(async () => { dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }); });
afterEach(() => { vi.restoreAllMocks(); dql.resetUnsafe(); });

/// A connection with a catalog of its own
function connection(type = ConnectorType.HYPER): ScriptConnection {
    return { connectionId: crypto.randomUUID(), connectorInfo: CONNECTOR_INFOS[type], catalog: dql.createCatalog() };
}

function state(names = ['1_alpha.sql', '2_beta.sql', '3_gamma.sql'], main: ScriptConnection = connection()): SessionScripts {
    const scripts: SessionScripts['scripts'] = {};
    const refs: SessionScripts['scriptRefs'] = {};
    for (const [index, name] of names.entries()) {
        const scriptSession = dql.createScriptSession(main.catalog);
        replaceScriptSessionText(scriptSession, `SELECT ${index + 1}`);
        const scriptKey = scriptSession.getCatalogEntryId();
        scripts[scriptKey] = {
            scriptKey, scriptSession, editorUpdate: null, analysisOutdated: true,
            annotations: createEmptyAnnotations(), statistics: Immutable.List(), completion: null,
            pendingDiff: null, latestQueryId: null, fileName: name, connection: main,
        };
        refs[name] = createScriptRef(scriptKey, name);
    }
    return {
        instance: dql, sessionId: crypto.randomUUID(), name: 'Test', connectionId: main.connectionId, settings: { cacheQueryResults: false },
        sessionMetadata: createEmptyMetadata(), connectorInfo: main.connectorInfo,
        connectionCatalog: main.catalog, scripts, scriptRefs: refs, scriptOrder: [...names],
        scriptFocus: { fileName: names[1] ?? names[0] ?? '' }, semanticUserFocus: null,
    };
}

function reduce(current: SessionScripts, action: Parameters<typeof reduceSessionScripts>[1], writer?: RecordingWriter) {
    return reduceSessionScripts(current, action, writer ?? new RecordingWriter(logger, new SessionTestBackend()), logger);
}

describe('V2 flat session script mutations', () => {
    it('persists session and script mutations before the connection ever becomes active', () => {
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        let current = state(['1_alpha.sql', '2_beta.sql']);
        for (const action of [
            { type: RENAME_SESSION, value: 'Offline session' },
            { type: RENAME_SCRIPT, value: { fileName: '1_alpha.sql', newFileName: 'offline' } },
            { type: CREATE_SCRIPT, value: { index: 1 } },
        ] as Parameters<typeof reduceSessionScripts>[1][]) {
            current = reduceSessionScripts(current, action, writer, logger);
        }
        expect(current.name).toBe('Offline session');
        current = reduceSessionScripts(current, {
            type: DELETE_SCRIPT, value: current.scriptOrder[0],
        }, writer, logger);
        expect(writer.records.some(task => task.type.description === 'WRITE_SESSION_PROPERTIES')).toBe(true);
        expect(writer.records.some(task => task.type.description === 'WRITE_SCRIPT')).toBe(true);
        expect(writer.records.some(task => task.type.description === 'RENAME_SCRIPT')).toBe(true);
        expect(writer.records.some(task => task.type.description === 'WRITE_SESSION_SCRIPTS')).toBe(true);
        expect(writer.records.some(task => task.type.description === 'DELETE_SCRIPT')).toBe(true);
    });

    it('persists settings together with the name and skips unchanged settings', () => {
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        let current = state();
        current = reduceSessionScripts(current, { type: UPDATE_SESSION_SETTINGS, value: { cacheQueryResults: true } }, writer, logger);
        expect(current.settings).toEqual({ cacheQueryResults: true });
        expect(writer.records[writer.records.length - 1]).toEqual({
            type: WRITE_SESSION_PROPERTIES, value: [current.sessionId, { name: 'Test', settings: { cacheQueryResults: true } }],
        });
        const writes = writer.records.length;
        expect(reduceSessionScripts(current, { type: UPDATE_SESSION_SETTINGS, value: { cacheQueryResults: true } }, writer, logger)).toBe(current);
        expect(writer.records).toHaveLength(writes);
    });

    it.each([
        [ConnectorType.HYPER, false],
        [ConnectorType.TRINO, true],
        [ConnectorType.SALESFORCE_DATA_CLOUD, true],
    ])('defaults %s sessions to caching %s, also when settings were never persisted', (type, cacheQueryResults) => {
        expect(createDefaultSessionSettings(CONNECTOR_INFOS[type])).toEqual({ cacheQueryResults });
        expect(readSessionSettings(undefined, CONNECTOR_INFOS[type])).toEqual({ cacheQueryResults });
        expect(readSessionSettings({ cacheQueryResults: !cacheQueryResults }, CONNECTOR_INFOS[type])).toEqual({ cacheQueryResults: !cacheQueryResults });
    });

    it('persists editor text changes with an inactive connection', () => {
        const current = state(['1_alpha.sql']);
        const scriptKey = current.scriptRefs['1_alpha.sql'].scriptId;
        const script = current.scripts[scriptKey];
        script.editorUpdate = script.scriptSession.analyze();
        replaceScriptSessionText(script.scriptSession, 'SELECT 42');
        const editorUpdate = script.scriptSession.analyze();
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        reduceSessionScripts(current, { type: UPDATE_FROM_PROCESSOR, value: {
            scriptKey,
            scriptSession: script.scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
        } }, writer, logger);
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.sessionId, '1_alpha.sql', 'SELECT 42'],
        }));
    });

    it('executes a stale unparseable script verbatim after analysis', async () => {
        const current = state(['1_remote.sql']);
        const sql = 'SELECT * FROM remote_table QUALIFY row_number() OVER (ORDER BY id) = 1;';
        const scriptKey = current.scriptRefs['1_remote.sql'].scriptId;
        replaceScriptSessionText(current.scripts[scriptKey].scriptSession, sql);
        const compiled = current.scripts[scriptKey].scriptSession.compileQuery(new core.buffers.formatting.FormattingConfigT(
            core.buffers.formatting.FormattingDialect.HYPER,
            core.buffers.formatting.FormattingMode.INLINE,
            120,
            2,
            false,
        ));
        expect(compiled.read().errorsLength()).toBeGreaterThan(0);
        expect(compiled.read().sql()).toBe(sql);
        compiled.destroy();
        const executeQuery = vi.fn(() => [11, Promise.resolve(null)] as [number, Promise<null>]);
        const modifySessionScripts = vi.fn((action) => action.type === ANALYZE_OUTDATED_SCRIPT
            ? Promise.resolve(reduce(current, action))
            : Promise.resolve(current));

        await runSessionScript(current, current.scripts[scriptKey], executeQuery,
            modifySessionScripts, logger);

        expect(executeQuery).toHaveBeenCalledWith(current.connectionId, expect.objectContaining({
            query: sql,
            cacheable: false,
            cacheSignature: '',
        }));
    });

    it('compiles visualizations in the session connector dialect', () => {
        const current = state(['1_chart.sql']);
        const scriptKey = current.scriptRefs['1_chart.sql'].scriptId;
        const scriptData = current.scripts[scriptKey];
        replaceScriptSessionText(scriptData.scriptSession,
            'select cast(payload as array(json)) from events visualize using vegalite (mark => bar)');
        scriptData.scriptSession.analyze();

        const trino = compileSessionQuery(scriptData, ConnectorType.TRINO);
        const hyper = compileSessionQuery(scriptData, ConnectorType.HYPER);
        expect(trino.sql).toContain('cast(payload as array(json))');
        expect(hyper.sql).toContain('cast(payload as json[])');
    });

    it('inserts at an indexed feed boundary and persists the new flat file', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: CREATE_SCRIPT, value: { index: 1 } }, writer);
        const names = next.scriptOrder;
        expect(names).toHaveLength(3);
        expect(next.scriptFocus.fileName).toBe(names[1]);
        expect(writer.records.some(task => task.type.description === 'WRITE_SCRIPT'
            && (task.value as string[])[1] === names[1])).toBe(true);
    });

    it('appends a script with text, analyzes it, and persists the text', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: CREATE_SCRIPT, value: { index: null, text: 'SELECT 42' } }, writer);
        const names = next.scriptOrder;
        expect(names).toHaveLength(3);
        expect(next.scriptFocus.fileName).toBe(names[2]);
        const created = next.scripts[next.scriptRefs[names[2]].scriptId];
        expect(created.scriptSession.getText()).toBe('SELECT 42');
        expect(created.analysisOutdated).toBe(false);
        expect(next.scripts[next.scriptRefs[names[0]].scriptId].analysisOutdated).toBe(true);
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.sessionId, names[2], 'SELECT 42'],
        }));
    });

    it('creates the first script of an empty session', () => {
        const next = reduce(state([]), { type: CREATE_SCRIPT, value: { index: null, text: 'SELECT 1' } });
        const names = next.scriptOrder;
        expect(names).toHaveLength(1);
        expect(next.scriptFocus.fileName).toBe(names[0]);
    });

    it('deletes the last script', () => {
        const current = state(['1_alpha.sql']);
        const next = reduce(current, { type: DELETE_SCRIPT, value: '1_alpha.sql' });
        expect(next.scriptRefs).toEqual({});
        expect(next.scripts).toEqual({});
        expect(next.scriptFocus.fileName).toBe('');
    });

    it('reorders through the script list without renaming files', () => {
        const current = state();
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: REORDER_SCRIPTS, value: ['3_gamma.sql', '1_alpha.sql', '2_beta.sql'] }, writer);
        expect(next.scriptOrder).toEqual(['3_gamma.sql', '1_alpha.sql', '2_beta.sql']);
        expect(next.scriptRefs).toBe(current.scriptRefs);
        expect(next.scriptFocus.fileName).toBe('2_beta.sql');
        expect(writer.records).toEqual([{
            type: WRITE_SESSION_SCRIPTS,
            value: [current.sessionId, {
                scripts: ['3_gamma.sql', '1_alpha.sql', '2_beta.sql'].map(name => ({ name, connectionId: current.connectionId })),
                connections: [],
            }],
        }]);
        // The same order changes nothing
        expect(reduce(next, { type: REORDER_SCRIPTS, value: next.scriptOrder })).toBe(next);
    });

    it('creates scripts without an ordering prefix', () => {
        const next = reduce(state(['1_alpha.sql']), { type: CREATE_SCRIPT, value: { index: 0 } });
        expect(next.scriptOrder).toHaveLength(2);
        expect(next.scriptOrder[1]).toBe('1_alpha.sql');
        expect(next.scriptOrder[0]).not.toMatch(/^\d+_/);
    });

    it('renames in place without keeping the ordering prefix', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: RENAME_SCRIPT, value: { fileName: '2_beta.sql', newFileName: 'report' } }, writer);
        expect(next.scriptRefs['report.sql']).toBeDefined();
        expect(next.scriptOrder).toEqual(['1_alpha.sql', 'report.sql']);
        expect(next.scriptFocus.fileName).toBe('report.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.sessionId, '2_beta.sql', 'report.sql'],
        }));
        expect(writer.records.some(task => task.type === WRITE_SESSION_SCRIPTS)).toBe(true);
        // The prefix is part of the name the user types
        expect(reduce(next, { type: RENAME_SCRIPT, value: { fileName: 'report.sql', newFileName: '02_report' } }).scriptOrder)
            .toEqual(['1_alpha.sql', '02_report.sql']);
        // Names that are not plain file names are ignored
        expect(reduce(next, { type: RENAME_SCRIPT, value: { fileName: 'report.sql', newFileName: 'a/b' } })).toBe(next);
    });

    it('moves a script to another connection under its script key', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const other = { ...connection(ConnectorType.TRINO), params: { trino: { endpoint: 'https://trino.example' } } as any };
        const scriptKey = current.scriptRefs['2_beta.sql'].scriptId;
        current.scripts[scriptKey] = { ...current.scripts[scriptKey], latestQueryId: 7, latestResultQueryId: 7 };
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: other } }, writer);
        const moved = next.scripts[scriptKey];
        expect(next.scriptRefs['2_beta.sql'].scriptId).toBe(scriptKey);
        expect(moved.connection).toBe(other);
        expect(moved.scriptSession.getText()).toBe('SELECT 2');
        expect(moved.latestQueryId).toBe(7);
        expect(moved.latestResultQueryId).toBe(7);
        expect(writer.records).toEqual([{
            type: WRITE_SESSION_SCRIPTS,
            value: [current.sessionId, {
                scripts: [
                    { name: '1_alpha.sql', connectionId: current.connectionId },
                    { name: '2_beta.sql', connectionId: other.connectionId },
                ],
                // The session file takes a copy of the new connection
                connections: [{ connectionId: other.connectionId, params: other.params }],
            }],
        }]);
        // The same connection changes nothing
        expect(reduce(next, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: other } })).toBe(next);
        // A script moves back under its key
        const back = reduce(next, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: defaultScriptConnection(next) } });
        expect(back.scripts[scriptKey].connection.connectionId).toBe(current.connectionId);
    });

    it('completes a script against the catalog of its own connection', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const alpha = current.scripts[current.scriptRefs['1_alpha.sql'].scriptId];
        replaceScriptSessionText(alpha.scriptSession, 'create table only_on_main (a int);');
        alpha.scriptSession.analyze();
        alpha.scriptSession.loadIntoCatalog(alpha.scriptKey);
        const completeTables = (next: SessionScripts) => {
            const beta = next.scripts[next.scriptRefs['2_beta.sql'].scriptId];
            const text = 'select * from only_on';
            replaceScriptSessionText(beta.scriptSession, text);
            beta.scriptSession.analyze();
            beta.scriptSession.setCursor(beta.scriptSession.getTextVersion(), BigInt(text.length));
            const completion = beta.scriptSession.completeAtCursor(10);
            try {
                const reader = completion.read();
                return Array.from({ length: reader.candidatesLength() }, (_, i) => reader.candidates(i)!.completionText());
            } finally {
                completion.destroy();
            }
        };
        // On the same connection, the table of the other script completes
        expect(completeTables(current)).toContain('only_on_main');
        // On another connection, the table is not visible
        const moved = reduce(current, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: connection() } });
        expect(completeTables(moved)).not.toContain('only_on_main');
    });

    it('only outdates the scripts of the connection whose catalog changed', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const other = connection();
        let next = reduce(current, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: other } });
        for (const script of Object.values(next.scripts)) script.analysisOutdated = false;
        next = reduce(next, { type: CATALOG_DID_UPDATE, value: other.connectionId });
        expect(next.scripts[next.scriptRefs['1_alpha.sql'].scriptId].analysisOutdated).toBe(false);
        expect(next.scripts[next.scriptRefs['2_beta.sql'].scriptId].analysisOutdated).toBe(true);
    });

    it('deletes the focused script, moves focus, and persists deletion', () => {
        const current = state();
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: DELETE_SCRIPT, value: '2_beta.sql' }, writer);
        expect(next.scriptRefs['2_beta.sql']).toBeUndefined();
        expect(next.scriptOrder).toEqual(['1_alpha.sql', '3_gamma.sql']);
        expect(next.scriptFocus.fileName).toBe('1_alpha.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({ value: [current.sessionId, '2_beta.sql'] }));
    });

    it('matches and replaces native flat-script snapshots with their order and connections', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const main = defaultScriptConnection(current);
        expect(sessionScriptsMatchStorageSnapshot(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT 1', connection: main },
            { name: '2_beta.sql', sql: 'SELECT 2', connection: main },
        ] })).toBe(true);
        // The order is part of the snapshot
        expect(sessionScriptsMatchStorageSnapshot(current, { scripts: [
            { name: '2_beta.sql', sql: 'SELECT 2', connection: main },
            { name: '1_alpha.sql', sql: 'SELECT 1', connection: main },
        ] })).toBe(false);
        const other = connection();
        const alphaKey = current.scriptRefs['1_alpha.sql'].scriptId;
        const next = replaceSessionScriptsFromStorage(current, { scripts: [
            { name: '3_added.sql', sql: 'SELECT 3', connection: main },
            { name: '1_alpha.sql', sql: 'SELECT changed', connection: other },
        ] }, logger);
        expect(next.scriptOrder).toEqual(['3_added.sql', '1_alpha.sql']);
        expect(next.scriptRefs['1_alpha.sql'].scriptId).toBe(alphaKey);
        expect(next.scripts[alphaKey].scriptSession.getText()).toBe('SELECT changed');
        expect(next.scripts[alphaKey].connection).toBe(other);
        expect(sessionScriptsMatchStorageSnapshot(next, { scripts: [
            { name: '3_added.sql', sql: 'SELECT 3', connection: main },
            { name: '1_alpha.sql', sql: 'SELECT changed', connection: other },
        ] })).toBe(true);
    });

    it('keeps a script usable when it can not move to another connection', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const scriptKey = current.scriptRefs['2_beta.sql'].scriptId;
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        vi.spyOn(dql, 'createScriptSessionWithEntryId').mockImplementation(() => { throw new Error('no session'); });
        expect(reduce(current, { type: SET_SCRIPT_CONNECTION, value: { fileName: '2_beta.sql', connection: connection() } }, writer)).toBe(current);
        expect(current.scripts[scriptKey].scriptSession.getText()).toBe('SELECT 2');
        expect(writer.records).toEqual([]);
    });

    it('keeps the current scripts when the scripts of storage can not be created', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const main = defaultScriptConnection(current);
        const alpha = current.scripts[current.scriptRefs['1_alpha.sql'].scriptId];
        // The moved script is created, the added one fails
        vi.spyOn(dql, 'createScriptSession').mockImplementation(() => { throw new Error('no session'); });
        expect(() => replaceSessionScriptsFromStorage(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT 1', connection: connection() },
            { name: '2_beta.sql', sql: 'SELECT 2', connection: main },
            { name: '3_added.sql', sql: 'SELECT 3', connection: main },
        ] }, logger)).toThrow('no session');
        expect(alpha.scriptSession.getText()).toBe('SELECT 1');
        expect(alpha.scriptSession.getCatalogEntryId()).toBe(alpha.scriptKey);
    });

    it('keeps the reference to an unresolved connection until a connection is picked', () => {
        const current = state(['1_alpha.sql']);
        const unknownId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
        const scriptKey = current.scriptRefs['1_alpha.sql'].scriptId;
        current.scripts[scriptKey] = { ...current.scripts[scriptKey], unresolvedConnectionId: unknownId };
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const created = reduce(current, { type: CREATE_SCRIPT, value: { index: null } }, writer);
        const listOf = (task: StorageWriteTaskVariant) => (task.value as [string, { scripts: Array<{ name: string; connectionId: string }> }])[1].scripts;
        expect(listOf(writer.records.find(task => task.type === WRITE_SESSION_SCRIPTS)!)[0]).toEqual({ name: '1_alpha.sql', connectionId: unknownId });

        // Picking the connection the script runs on replaces the reference
        writer.records.length = 0;
        const picked = reduce(created, { type: SET_SCRIPT_CONNECTION, value: { fileName: '1_alpha.sql', connection: defaultScriptConnection(created) } }, writer);
        expect(picked.scripts[scriptKey].unresolvedConnectionId).toBeUndefined();
        expect(picked.scripts[scriptKey].scriptSession).toBe(current.scripts[scriptKey].scriptSession);
        expect(listOf(writer.records[0])[0]).toEqual({ name: '1_alpha.sql', connectionId: current.connectionId });
    });
});
