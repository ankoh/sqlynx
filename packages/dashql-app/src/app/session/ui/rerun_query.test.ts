import { describe, expect, it, vi } from 'vitest';
import { tableFromArrays, type Table } from 'apache-arrow';

import { ANALYZE_OUTDATED_SCRIPT, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, reduceSessionScripts, type SessionScripts, type ScriptData } from '../scripts/session_scripts.js';
import { ConnectorType } from '../../connections/connector_info.js';
import * as dashql from '@ankoh/dashql-core';
import { registerSessionScriptQuery, runSessionScript } from './rerun_query.js';

describe('registerSessionScriptQuery', () => {
    const scriptData = { scriptKey: 7 } as ScriptData;

    it('registers the query immediately', () => {
        const modifySessionScripts = vi.fn();
        const execution = Promise.resolve(null);

        registerSessionScriptQuery(scriptData, 11, 'SELECT * FROM remote', execution, modifySessionScripts);
        expect(modifySessionScripts).toHaveBeenCalledOnce();
        expect(modifySessionScripts).toHaveBeenCalledWith({ type: REGISTER_QUERY, value: [7, 11] });
    });

    it.each(['null', 'rejected'])('does not retain %s results', async kind => {
        const modifySessionScripts = vi.fn();
        const execution = kind === 'null' ? Promise.resolve(null) : Promise.reject(new Error('Failed'));
        registerSessionScriptQuery(scriptData, 11, 'SELECT 1', execution, modifySessionScripts);
        await execution.catch(() => {});
        expect(modifySessionScripts).toHaveBeenCalledOnce();
    });

    it('retains successful results without overwriting command status or newer overlapping results', async () => {
        let session = { scripts: { 7: { scriptKey: 7, latestQueryId: 10 } } } as unknown as SessionScripts;
        const modifySessionScripts = vi.fn((action) => {
            session = reduceSessionScripts(session, action,
                null as unknown as Parameters<typeof reduceSessionScripts>[2],
                { warn: vi.fn() } as unknown as Parameters<typeof reduceSessionScripts>[3]);
        });
        let resolveOlder!: (table: Table) => void;
        const older = new Promise<Table>(resolve => { resolveOlder = resolve; });
        registerSessionScriptQuery(session.scripts[7], 11, 'SELECT 1', older, modifySessionScripts);
        expect(session.scripts[7].latestResultQueryId).toBe(10);
        const newer = Promise.resolve(tableFromArrays({ value: [2] }));
        registerSessionScriptQuery(session.scripts[7], 12, 'SELECT 2', newer, modifySessionScripts);
        await newer;
        expect(session.scripts[7].latestResultQueryId).toBe(12);
        registerSessionScriptQuery(session.scripts[7], 13, 'COMMAND', Promise.resolve(null), modifySessionScripts);
        resolveOlder(tableFromArrays({ value: [1] }));
        await older;
        expect(modifySessionScripts).toHaveBeenCalledWith({ type: REGISTER_SCRIPT_RESULT, value: [7, 11] });
        expect(session.scripts[7].latestResultQueryId).toBe(12);
        expect(session.scripts[7].latestQueryId).toBe(13);
    });

    it('retains an older successful result even if a newer execution returned no result', async () => {
        let session = { scripts: { 7: { scriptKey: 7, latestQueryId: null, latestResultQueryId: null } } } as unknown as SessionScripts;
        const modifySessionScripts = vi.fn((action) => {
            session = reduceSessionScripts(session, action,
                null as unknown as Parameters<typeof reduceSessionScripts>[2],
                { warn: vi.fn() } as unknown as Parameters<typeof reduceSessionScripts>[3]);
        });
        let resolve!: (table: Table) => void;
        const execution = new Promise<Table>(yes => { resolve = yes; });
        registerSessionScriptQuery(session.scripts[7], 11, 'SELECT 1', execution, modifySessionScripts);
        registerSessionScriptQuery(session.scripts[7], 12, 'COMMAND', Promise.resolve(null), modifySessionScripts);
        resolve(tableFromArrays({ value: [1] }));
        await execution;
        expect(session.scripts[7].latestQueryId).toBe(12);
        expect(session.scripts[7].latestResultQueryId).toBe(11);
    });
});

describe('runSessionScript', () => {
    it.each([
        [undefined, true], [null, true], [5, true], [undefined, false],
    ])('uses retained result id %s and session caching %s after analyzing an outdated script', async (latestResultQueryId, cacheQueryResults) => {
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
            connection: { connectionId: 'connection', connectorInfo: { connectorType: ConnectorType.TRINO } },
        } as unknown as ScriptData;
        const analyzed = {
            ...outdated,
            analysisOutdated: false,
        };
        const sessionScripts = {
            scripts: { 7: outdated }, connectorInfo: { connectorType: ConnectorType.HYPER }, settings: { cacheQueryResults },
        } as unknown as SessionScripts;
        const modifySessionScripts = vi.fn((action) => {
            if (action.type === ANALYZE_OUTDATED_SCRIPT) {
                return Promise.resolve({ scripts: { 7: analyzed } } as unknown as SessionScripts);
            }
        });
        const executeQuery = vi.fn(() => [11, Promise.resolve(null)] as [number, Promise<null>]);

        const execution = runSessionScript(
            sessionScripts,
            outdated,
            executeQuery,
            modifySessionScripts,
            { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any,
        );
        expect(executeQuery).not.toHaveBeenCalled();
        await execution;

        expect(modifySessionScripts).toHaveBeenNthCalledWith(1, {
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
        expect(modifySessionScripts).toHaveBeenNthCalledWith(2, {
            type: REGISTER_QUERY,
            value: [7, 11],
        });
    });
});
