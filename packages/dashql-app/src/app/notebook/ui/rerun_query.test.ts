import { describe, expect, it, vi } from 'vitest';
import { tableFromArrays, type Table } from 'apache-arrow';

import { ANALYZE_OUTDATED_SCRIPT, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, reduceNotebookScripts, type NotebookScripts, type ScriptData } from '../scripts/notebook_scripts.js';
import { ConnectorType } from '../connections/connector_info.js';
import * as dashql from '@ankoh/dashql-core';
import { registerNotebookScriptQuery, runNotebookScript } from './rerun_query.js';

describe('registerNotebookScriptQuery', () => {
    const scriptData = { scriptKey: 7 } as ScriptData;

    it('registers the query immediately', () => {
        const modifyNotebookScripts = vi.fn();
        const execution = Promise.resolve(null);

        registerNotebookScriptQuery(scriptData, 11, 'SELECT * FROM remote', execution, modifyNotebookScripts);
        expect(modifyNotebookScripts).toHaveBeenCalledOnce();
        expect(modifyNotebookScripts).toHaveBeenCalledWith({ type: REGISTER_QUERY, value: [7, 11] });
    });

    it.each(['null', 'rejected'])('does not retain %s results', async kind => {
        const modifyNotebookScripts = vi.fn();
        const execution = kind === 'null' ? Promise.resolve(null) : Promise.reject(new Error('Failed'));
        registerNotebookScriptQuery(scriptData, 11, 'SELECT 1', execution, modifyNotebookScripts);
        await execution.catch(() => {});
        expect(modifyNotebookScripts).toHaveBeenCalledOnce();
    });

    it('retains successful results without overwriting command status or newer overlapping results', async () => {
        let notebook = { scripts: { 7: { scriptKey: 7, latestQueryId: 10 } } } as unknown as NotebookScripts;
        const modifyNotebookScripts = vi.fn((action) => {
            notebook = reduceNotebookScripts(notebook, action,
                null as unknown as Parameters<typeof reduceNotebookScripts>[2],
                { warn: vi.fn() } as unknown as Parameters<typeof reduceNotebookScripts>[3], false);
        });
        let resolveOlder!: (table: Table) => void;
        const older = new Promise<Table>(resolve => { resolveOlder = resolve; });
        registerNotebookScriptQuery(notebook.scripts[7], 11, 'SELECT 1', older, modifyNotebookScripts);
        expect(notebook.scripts[7].latestResultQueryId).toBe(10);
        const newer = Promise.resolve(tableFromArrays({ value: [2] }));
        registerNotebookScriptQuery(notebook.scripts[7], 12, 'SELECT 2', newer, modifyNotebookScripts);
        await newer;
        expect(notebook.scripts[7].latestResultQueryId).toBe(12);
        registerNotebookScriptQuery(notebook.scripts[7], 13, 'COMMAND', Promise.resolve(null), modifyNotebookScripts);
        resolveOlder(tableFromArrays({ value: [1] }));
        await older;
        expect(modifyNotebookScripts).toHaveBeenCalledWith({ type: REGISTER_SCRIPT_RESULT, value: [7, 11] });
        expect(notebook.scripts[7].latestResultQueryId).toBe(12);
        expect(notebook.scripts[7].latestQueryId).toBe(13);
    });

    it('retains an older successful result even if a newer execution returned no result', async () => {
        let notebook = { scripts: { 7: { scriptKey: 7, latestQueryId: null, latestResultQueryId: null } } } as unknown as NotebookScripts;
        const modifyNotebookScripts = vi.fn((action) => {
            notebook = reduceNotebookScripts(notebook, action,
                null as unknown as Parameters<typeof reduceNotebookScripts>[2],
                { warn: vi.fn() } as unknown as Parameters<typeof reduceNotebookScripts>[3], false);
        });
        let resolve!: (table: Table) => void;
        const execution = new Promise<Table>(yes => { resolve = yes; });
        registerNotebookScriptQuery(notebook.scripts[7], 11, 'SELECT 1', execution, modifyNotebookScripts);
        registerNotebookScriptQuery(notebook.scripts[7], 12, 'COMMAND', Promise.resolve(null), modifyNotebookScripts);
        resolve(tableFromArrays({ value: [1] }));
        await execution;
        expect(notebook.scripts[7].latestQueryId).toBe(12);
        expect(notebook.scripts[7].latestResultQueryId).toBe(11);
    });
});

describe('runNotebookScript', () => {
    it.each([
        [undefined, true], [null, true], [5, true], [undefined, false],
    ])('uses retained result id %s and notebook caching %s after analyzing an outdated script', async (latestResultQueryId, cacheQueryResults) => {
        const compileQuery = vi.fn((_config: dashql.buffers.formatting.FormattingConfigT) => ({
            read: () => ({
                errorsLength: () => 0,
                sql: () => 'SELECT 1',
                cacheSignature: () => 'signature',
                cacheable: () => true,
            }),
            destroy: () => { },
        }));
        const scriptExecution = {};
        const outdated = {
            scriptKey: 7,
            scriptSession: { compileQuery, startExecution: () => scriptExecution },
            analysisOutdated: true,
            annotations: { visualizeQuery: null },
            latestQueryId: 9,
            latestResultQueryId,
        } as unknown as ScriptData;
        const analyzed = {
            ...outdated,
            analysisOutdated: false,
        };
        const notebookScripts = {
            scripts: { 7: outdated }, connectorInfo: { connectorType: ConnectorType.TRINO }, settings: { cacheQueryResults },
        } as unknown as NotebookScripts;
        const modifyNotebookScripts = vi.fn((action) => {
            if (action.type === ANALYZE_OUTDATED_SCRIPT) {
                return Promise.resolve({ scripts: { 7: analyzed } } as unknown as NotebookScripts);
            }
        });
        const executeQuery = vi.fn(() => [11, Promise.resolve(null)] as [number, Promise<null>]);

        const execution = runNotebookScript(
            'connection',
            notebookScripts,
            outdated,
            executeQuery,
            modifyNotebookScripts,
            { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any,
        );
        expect(executeQuery).not.toHaveBeenCalled();
        await execution;

        expect(modifyNotebookScripts).toHaveBeenNthCalledWith(1, {
            type: ANALYZE_OUTDATED_SCRIPT,
            value: 7,
        });
        expect(compileQuery).toHaveBeenCalledOnce();
        expect(compileQuery.mock.calls[0][0].dialect).toBe(dashql.buffers.formatting.FormattingDialect.TRINO);
        expect(executeQuery).toHaveBeenCalledWith('connection', expect.objectContaining({
            query: 'SELECT 1',
            scriptExecution,
            cacheable: cacheQueryResults,
            cacheSignature: 'signature',
            replaceComputationId: latestResultQueryId === undefined ? 9 : latestResultQueryId,
        }));
        expect(modifyNotebookScripts).toHaveBeenNthCalledWith(2, {
            type: REGISTER_QUERY,
            value: [7, 11],
        });
    });
});
