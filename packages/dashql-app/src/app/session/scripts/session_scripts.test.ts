import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connections/connector_info.js';
import { SessionTestBackend } from '../../storage/session_test_backend.js';
import { StorageWriter, WRITE_SESSION_PROPERTIES, type StorageWriteTaskVariant } from '../../storage/storage_writer.js';
import {
    ANALYZE_OUTDATED_SCRIPT,
    compileSessionQuery,
    CREATE_SCRIPT,
    DELETE_SCRIPT,
    getSortedScriptFileNames,
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
afterEach(() => dql.resetUnsafe());

function state(names = ['1_alpha.sql', '2_beta.sql', '3_gamma.sql']): SessionScripts {
    const catalog = dql.createCatalog();
    const scripts: SessionScripts['scripts'] = {};
    const refs: SessionScripts['scriptRefs'] = {};
    for (const [index, name] of names.entries()) {
        const scriptSession = dql.createScriptSession(catalog);
        replaceScriptSessionText(scriptSession, `SELECT ${index + 1}`);
        const scriptKey = scriptSession.getCatalogEntryId();
        scripts[scriptKey] = {
            scriptKey, scriptSession, editorUpdate: null, analysisOutdated: true,
            annotations: createEmptyAnnotations(), statistics: Immutable.List(), completion: null,
            pendingDiff: null, latestQueryId: null, fileName: name,
        };
        refs[name] = createScriptRef(scriptKey, name);
    }
    return {
        instance: dql, sessionId: crypto.randomUUID(), name: 'Test', databaseId: crypto.randomUUID(), settings: { cacheQueryResults: false },
        sessionMetadata: createEmptyMetadata(), connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        connectionCatalog: catalog, scripts, scriptRefs: refs,
        scriptFocus: { fileName: names[1] ?? names[0] ?? '' }, semanticUserFocus: null,
    };
}

function reduce(current: SessionScripts, action: Parameters<typeof reduceSessionScripts>[1], writer?: RecordingWriter) {
    return reduceSessionScripts(current, action, writer ?? new RecordingWriter(logger, new SessionTestBackend()), logger, true);
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
            current = reduceSessionScripts(current, action, writer, logger, false);
        }
        expect(current.name).toBe('Offline session');
        current = reduceSessionScripts(current, {
            type: DELETE_SCRIPT, value: getSortedScriptFileNames(current.scriptRefs)[0],
        }, writer, logger, false);
        expect(writer.records.some(task => task.type.description === 'WRITE_SESSION_PROPERTIES')).toBe(true);
        expect(writer.records.filter(task => task.type.description === 'WRITE_SCRIPT').length).toBeGreaterThanOrEqual(2);
        expect(writer.records.some(task => task.type.description === 'DELETE_SCRIPT')).toBe(true);
    });

    it('persists settings together with the name and skips unchanged settings', () => {
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        let current = state();
        current = reduceSessionScripts(current, { type: UPDATE_SESSION_SETTINGS, value: { cacheQueryResults: true } }, writer, logger, false);
        expect(current.settings).toEqual({ cacheQueryResults: true });
        expect(writer.records[writer.records.length - 1]).toEqual({
            type: WRITE_SESSION_PROPERTIES, value: [current.sessionId, { name: 'Test', settings: { cacheQueryResults: true } }],
        });
        const writes = writer.records.length;
        expect(reduceSessionScripts(current, { type: UPDATE_SESSION_SETTINGS, value: { cacheQueryResults: true } }, writer, logger, false)).toBe(current);
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
        } }, writer, logger, false);
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

        await runSessionScript('database', current, current.scripts[scriptKey], executeQuery,
            modifySessionScripts, logger);

        expect(executeQuery).toHaveBeenCalledWith('database', expect.objectContaining({
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
        const names = getSortedScriptFileNames(next.scriptRefs);
        expect(names).toHaveLength(3);
        expect(next.scriptFocus.fileName).toBe(names[1]);
        expect(writer.records.some(task => task.type.description === 'WRITE_SCRIPT'
            && (task.value as string[])[1] === names[1])).toBe(true);
    });

    it('appends a script with text, analyzes it, and persists the text', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: CREATE_SCRIPT, value: { index: null, text: 'SELECT 42' } }, writer);
        const names = getSortedScriptFileNames(next.scriptRefs);
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
        const names = getSortedScriptFileNames(next.scriptRefs);
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

    it('reorders by dense prefixes and follows focus', () => {
        const current = state();
        const next = reduce(current, { type: REORDER_SCRIPTS, value: ['3_gamma.sql', '1_alpha.sql', '2_beta.sql'] });
        expect(getSortedScriptFileNames(next.scriptRefs)).toEqual(['1_gamma.sql', '2_alpha.sql', '3_beta.sql']);
        expect(next.scriptFocus.fileName).toBe('3_beta.sql');
    });

    it('renames in place and persists a flat rename', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: RENAME_SCRIPT, value: { fileName: '2_beta.sql', newFileName: 'report' } }, writer);
        expect(next.scriptRefs['2_report.sql']).toBeDefined();
        expect(next.scriptFocus.fileName).toBe('2_report.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.sessionId, '2_beta.sql', '2_report.sql'],
        }));
    });

    it('deletes the focused script, moves focus, and persists deletion', () => {
        const current = state();
        const writer = new RecordingWriter(logger, new SessionTestBackend());
        const next = reduce(current, { type: DELETE_SCRIPT, value: '2_beta.sql' }, writer);
        expect(next.scriptRefs['2_beta.sql']).toBeUndefined();
        expect(next.scriptFocus.fileName).toBe('1_alpha.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({ value: [current.sessionId, '2_beta.sql'] }));
    });

    it('matches and replaces native flat-script snapshots without draft/page state', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        expect(sessionScriptsMatchStorageSnapshot(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT 1' },
            { name: '2_beta.sql', sql: 'SELECT 2' },
        ] })).toBe(true);
        const next = replaceSessionScriptsFromStorage(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT changed' },
            { name: '3_added.sql', sql: 'SELECT 3' },
        ] }, logger);
        expect(getSortedScriptFileNames(next.scriptRefs)).toEqual(['1_alpha.sql', '3_added.sql']);
        expect(next.scripts[next.scriptRefs['1_alpha.sql'].scriptId].scriptSession.getText()).toBe('SELECT changed');
        expect(sessionScriptsMatchStorageSnapshot(next, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT changed' },
            { name: '3_added.sql', sql: 'SELECT 3' },
        ] })).toBe(true);
    });
});
