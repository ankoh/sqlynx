import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connections/connector_info.js';
import { NotebookTestBackend } from '../persistence/notebook_test_backend.js';
import { StorageWriter, type StorageWriteTaskVariant } from '../persistence/storage_writer.js';
import {
    ANALYZE_OUTDATED_SCRIPT,
    compileNotebookQuery,
    CREATE_SCRIPT,
    DELETE_SCRIPT,
    getSortedScriptFileNames,
    notebookScriptsMatchStorageSnapshot,
    type NotebookScripts,
    reduceNotebookScripts,
    RENAME_SCRIPT,
    RENAME_NOTEBOOK,
    UPDATE_FROM_PROCESSOR,
    REORDER_SCRIPTS,
    replaceNotebookScriptsFromStorage,
    replaceScriptSessionText,
} from './notebook_scripts.js';
import { runNotebookScript } from '../ui/rerun_query.js';
import { createEmptyAnnotations, createEmptyMetadata, createScriptRef } from './script_types.js';

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

function state(names = ['1_alpha.sql', '2_beta.sql', '3_gamma.sql']): NotebookScripts {
    const catalog = dql.createCatalog();
    const scripts: NotebookScripts['scripts'] = {};
    const refs: NotebookScripts['scriptRefs'] = {};
    for (const [index, name] of names.entries()) {
        const session = dql.createScriptSession(catalog);
        replaceScriptSessionText(session, `SELECT ${index + 1}`);
        const scriptKey = session.getCatalogEntryId();
        scripts[scriptKey] = {
            scriptKey, scriptSession: session, editorUpdate: null, analysisOutdated: true,
            annotations: createEmptyAnnotations(), statistics: Immutable.List(), completion: null,
            pendingDiff: null, latestQueryId: null, fileName: name,
        };
        refs[name] = createScriptRef(scriptKey, name);
    }
    return {
        instance: dql, notebookId: crypto.randomUUID(), name: 'Test', databaseId: crypto.randomUUID(),
        notebookMetadata: createEmptyMetadata(), connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        connectionCatalog: catalog, scripts, scriptRefs: refs,
        scriptFocus: { fileName: names[1] ?? names[0] ?? '' }, semanticUserFocus: null,
    };
}

function reduce(current: NotebookScripts, action: Parameters<typeof reduceNotebookScripts>[1], writer?: RecordingWriter) {
    return reduceNotebookScripts(current, action, writer ?? new RecordingWriter(logger, new NotebookTestBackend()), logger, true);
}

describe('V2 flat notebook script mutations', () => {
    it('persists notebook and script mutations before the connection ever becomes active', () => {
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        let current = state(['1_alpha.sql', '2_beta.sql']);
        for (const action of [
            { type: RENAME_NOTEBOOK, value: 'Offline notebook' },
            { type: RENAME_SCRIPT, value: { fileName: '1_alpha.sql', newFileName: 'offline' } },
            { type: CREATE_SCRIPT, value: { index: 1 } },
        ] as Parameters<typeof reduceNotebookScripts>[1][]) {
            current = reduceNotebookScripts(current, action, writer, logger, false);
        }
        expect(current.name).toBe('Offline notebook');
        current = reduceNotebookScripts(current, {
            type: DELETE_SCRIPT, value: getSortedScriptFileNames(current.scriptRefs)[0],
        }, writer, logger, false);
        expect(writer.records.some(task => task.type.description === 'WRITE_NOTEBOOK_NAME')).toBe(true);
        expect(writer.records.filter(task => task.type.description === 'WRITE_SCRIPT').length).toBeGreaterThanOrEqual(2);
        expect(writer.records.some(task => task.type.description === 'DELETE_SCRIPT')).toBe(true);
    });

    it('persists editor text changes with an inactive connection', () => {
        const current = state(['1_alpha.sql']);
        const scriptKey = current.scriptRefs['1_alpha.sql'].scriptId;
        const script = current.scripts[scriptKey];
        script.editorUpdate = script.scriptSession.analyze();
        replaceScriptSessionText(script.scriptSession, 'SELECT 42');
        const editorUpdate = script.scriptSession.analyze();
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        reduceNotebookScripts(current, { type: UPDATE_FROM_PROCESSOR, value: {
            scriptKey,
            scriptSession: script.scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
        } }, writer, logger, false);
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.notebookId, '1_alpha.sql', 'SELECT 42'],
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
        const modifyNotebookScripts = vi.fn((action) => action.type === ANALYZE_OUTDATED_SCRIPT
            ? Promise.resolve(reduce(current, action))
            : Promise.resolve(current));

        await runNotebookScript('database', current, current.scripts[scriptKey], executeQuery,
            modifyNotebookScripts, logger);

        expect(executeQuery).toHaveBeenCalledWith('database', expect.objectContaining({
            query: sql,
            cacheable: false,
            cacheSignature: '',
        }));
    });

    it('compiles visualizations in the notebook connector dialect', () => {
        const current = state(['1_chart.sql']);
        const scriptKey = current.scriptRefs['1_chart.sql'].scriptId;
        const scriptData = current.scripts[scriptKey];
        replaceScriptSessionText(scriptData.scriptSession,
            'select cast(payload as array(json)) from events visualize using vegalite (mark => bar)');
        scriptData.scriptSession.analyze();

        const trino = compileNotebookQuery(scriptData, ConnectorType.TRINO);
        const hyper = compileNotebookQuery(scriptData, ConnectorType.HYPER);
        expect(trino.sql).toContain('cast(payload as array(json))');
        expect(hyper.sql).toContain('cast(payload as json[])');
    });

    it('inserts at an indexed feed boundary and persists the new flat file', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        const next = reduce(current, { type: CREATE_SCRIPT, value: { index: 1 } }, writer);
        const names = getSortedScriptFileNames(next.scriptRefs);
        expect(names).toHaveLength(3);
        expect(next.scriptFocus.fileName).toBe(names[1]);
        expect(writer.records.some(task => task.type.description === 'WRITE_SCRIPT'
            && (task.value as string[])[1] === names[1])).toBe(true);
    });

    it('appends a script with text, analyzes it, and persists the text', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        const next = reduce(current, { type: CREATE_SCRIPT, value: { index: null, text: 'SELECT 42' } }, writer);
        const names = getSortedScriptFileNames(next.scriptRefs);
        expect(names).toHaveLength(3);
        expect(next.scriptFocus.fileName).toBe(names[2]);
        const created = next.scripts[next.scriptRefs[names[2]].scriptId];
        expect(created.scriptSession.getText()).toBe('SELECT 42');
        expect(created.analysisOutdated).toBe(false);
        expect(next.scripts[next.scriptRefs[names[0]].scriptId].analysisOutdated).toBe(true);
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.notebookId, names[2], 'SELECT 42'],
        }));
    });

    it('creates the first script of an empty notebook', () => {
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
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        const next = reduce(current, { type: RENAME_SCRIPT, value: { fileName: '2_beta.sql', newFileName: 'report' } }, writer);
        expect(next.scriptRefs['2_report.sql']).toBeDefined();
        expect(next.scriptFocus.fileName).toBe('2_report.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({
            value: [current.notebookId, '2_beta.sql', '2_report.sql'],
        }));
    });

    it('deletes the focused script, moves focus, and persists deletion', () => {
        const current = state();
        const writer = new RecordingWriter(logger, new NotebookTestBackend());
        const next = reduce(current, { type: DELETE_SCRIPT, value: '2_beta.sql' }, writer);
        expect(next.scriptRefs['2_beta.sql']).toBeUndefined();
        expect(next.scriptFocus.fileName).toBe('1_alpha.sql');
        expect(writer.records).toContainEqual(expect.objectContaining({ value: [current.notebookId, '2_beta.sql'] }));
    });

    it('matches and replaces native flat-script snapshots without draft/page state', () => {
        const current = state(['1_alpha.sql', '2_beta.sql']);
        expect(notebookScriptsMatchStorageSnapshot(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT 1' },
            { name: '2_beta.sql', sql: 'SELECT 2' },
        ] })).toBe(true);
        const next = replaceNotebookScriptsFromStorage(current, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT changed' },
            { name: '3_added.sql', sql: 'SELECT 3' },
        ] }, logger);
        expect(getSortedScriptFileNames(next.scriptRefs)).toEqual(['1_alpha.sql', '3_added.sql']);
        expect(next.scripts[next.scriptRefs['1_alpha.sql'].scriptId].scriptSession.getText()).toBe('SELECT changed');
        expect(notebookScriptsMatchStorageSnapshot(next, { scripts: [
            { name: '1_alpha.sql', sql: 'SELECT changed' },
            { name: '3_added.sql', sql: 'SELECT 3' },
        ] })).toBe(true);
    });
});
