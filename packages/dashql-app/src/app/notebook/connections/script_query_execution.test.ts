// @vitest-environment node

import * as arrow from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import * as core from '@ankoh/dashql-core';
import type { DashQLScriptExecution } from '@ankoh/dashql-core';
import { TestLogger } from '../../../platform/logger/test_logger.js';
import { createTrace } from '../../../platform/logger/trace_context.js';
import { QueryType } from '../../../query/query_execution_state.js';
import type { QueryExecutionArgs } from './query_execution_args.js';
import { executeScriptQuery } from './script_query_execution.js';

const metadata = {
    queryType: QueryType.USER_PROVIDED,
    title: null,
    description: null,
    issuer: null,
    userProvided: true,
};

function pending(id: bigint, index: number, sql: string, producesOutput: boolean) {
    return new core.buffers.execution.PendingStatementT(id, index, index, 2, sql, producesOutput);
}

function update(
    phase: core.buffers.execution.ScriptExecutionPhase,
    statement: core.buffers.execution.PendingStatementT | null,
) {
    return new core.buffers.execution.ScriptExecutionUpdateT(
        core.buffers.execution.ScriptExecutionProtocolError.NONE,
        null,
        new core.buffers.execution.ScriptExecutionSnapshotT(phase, 1n, statement?.index ?? 2, 2, 1, null),
        statement,
    );
}

function createExecution(updates: core.buffers.execution.ScriptExecutionUpdateT[]) {
    return {
        start: vi.fn(() => updates.shift()!),
        resume: vi.fn(() => updates.shift()!),
        cancel: vi.fn(),
        destroy: vi.fn(),
    } as unknown as DashQLScriptExecution;
}

function queryArgs(): QueryExecutionArgs {
    return { query: 'script', metadata };
}

describe('executeScriptQuery', () => {
    it('executes statements in order and returns only the output statement table', async () => {
        const first = pending(10n, 1, 'CREATE TABLE t(a INT)', false);
        const second = pending(11n, 2, 'SELECT * FROM t', true);
        const execution = createExecution([
            update(core.buffers.execution.ScriptExecutionPhase.RUNNING, first),
            update(core.buffers.execution.ScriptExecutionPhase.RUNNING, second),
            update(core.buffers.execution.ScriptExecutionPhase.SUCCEEDED, null),
        ]);
        const output = arrow.tableFromArrays({ value: [42] });
        const executeStatement = vi.fn(async (_args: QueryExecutionArgs, producesOutput: boolean) => producesOutput ? output : null);
        const statementEvents: string[] = [];

        const result = await executeScriptQuery({
            execution,
            queryArgs: queryArgs(),
            abortSignal: new AbortController().signal,
            logger: new TestLogger().withTrace(createTrace()),
            notebookId: 'notebook',
            queryId: 7,
            logTarget: 'test',
            callbacks: {
                executeStatement,
                onStatementStarted: (index, count) => statementEvents.push(`started:${index}/${count}`),
                onStatementSucceeded: (index, count) => statementEvents.push(`succeeded:${index}/${count}`),
                setResultStream: vi.fn(),
            },
        });

        expect(executeStatement.mock.calls.map(([args, producesOutput]) => [args.query, producesOutput])).toEqual([
            ['CREATE TABLE t(a INT)', false],
            ['SELECT * FROM t', true],
        ]);
        expect(result).toBe(output);
        expect(statementEvents).toEqual([
            'started:1/2',
            'succeeded:1/2',
            'started:2/2',
            'succeeded:2/2',
        ]);
        expect(execution.resume).toHaveBeenCalledTimes(2);
        expect(execution.destroy).toHaveBeenCalledOnce();
    });

    it('reports a failed statement and stops execution', async () => {
        const statement = pending(10n, 1, 'BROKEN', false);
        const execution = createExecution([
            update(core.buffers.execution.ScriptExecutionPhase.RUNNING, statement),
            update(core.buffers.execution.ScriptExecutionPhase.FAILED, null),
        ]);
        const error = new Error('connector failed');

        await expect(executeScriptQuery({
            execution,
            queryArgs: queryArgs(),
            abortSignal: new AbortController().signal,
            logger: new TestLogger().withTrace(createTrace()),
            notebookId: 'notebook',
            queryId: 7,
            logTarget: 'test',
            callbacks: {
                executeStatement: vi.fn().mockRejectedValue(error),
                onStatementStarted: vi.fn(),
                onStatementSucceeded: vi.fn(),
                setResultStream: vi.fn(),
            },
        })).rejects.toBe(error);

        const failed = vi.mocked(execution.resume).mock.calls[0][0];
        expect(failed.status).toBe(core.buffers.execution.StatementResultStatus.FAILED);
        expect(failed.error).toBe('connector failed');
        expect(execution.destroy).toHaveBeenCalledOnce();
    });

    it('cancels the active core execution when aborted', async () => {
        const statement = pending(10n, 1, 'SELECT slow()', true);
        const execution = createExecution([
            update(core.buffers.execution.ScriptExecutionPhase.RUNNING, statement),
        ]);
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(executeScriptQuery({
            execution,
            queryArgs: queryArgs(),
            abortSignal: cancellation.signal,
            logger: new TestLogger().withTrace(createTrace()),
            notebookId: 'notebook',
            queryId: 7,
            logTarget: 'test',
            callbacks: {
                executeStatement: vi.fn(),
                onStatementStarted: vi.fn(),
                onStatementSucceeded: vi.fn(),
                setResultStream: vi.fn(),
            },
        })).rejects.toMatchObject({ name: 'AbortError' });

        expect(execution.cancel).toHaveBeenCalledOnce();
        expect(execution.resume).not.toHaveBeenCalled();
        expect(execution.destroy).toHaveBeenCalledOnce();
    });
    it('reports the catalog changes of statements that succeeded', async () => {
        const first = pending(10n, 1, 'CREATE TABLE t(a INT)', false);
        const second = pending(11n, 2, 'SELECT * FROM t', true);
        const change = new core.buffers.catalog.CatalogChangeT(
            core.buffers.catalog.CatalogChangeType.CREATE_RELATION, '', '', 't', ['a'], false);
        const afterCreate = update(core.buffers.execution.ScriptExecutionPhase.RUNNING, second);
        afterCreate.catalogChanges = [change];
        const execution = createExecution([
            update(core.buffers.execution.ScriptExecutionPhase.RUNNING, first),
            afterCreate,
            update(core.buffers.execution.ScriptExecutionPhase.SUCCEEDED, null),
        ]);
        const onCatalogChanges = vi.fn();

        await executeScriptQuery({
            execution,
            queryArgs: queryArgs(),
            abortSignal: new AbortController().signal,
            logger: new TestLogger().withTrace(createTrace()),
            notebookId: 'notebook',
            queryId: 7,
            logTarget: 'test',
            callbacks: {
                executeStatement: vi.fn(async () => null),
                onStatementStarted: vi.fn(),
                onStatementSucceeded: vi.fn(),
                onCatalogChanges,
                setResultStream: vi.fn(),
            },
        });

        expect(onCatalogChanges).toHaveBeenCalledExactlyOnceWith([change]);
    });
});
