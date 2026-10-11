import * as arrow from 'apache-arrow';

import * as core from '@ankoh/dashql-core';
import type { DashQLScriptExecution } from '@ankoh/dashql-core';
import type { TracedLogger } from '../../../platform/logger/logger.js';
import { LoggableException, stringifyError } from '../../../platform/logger/logger.js';
import type { QueryExecutionResponseStream } from '../../../query/query_execution_state.js';
import type { QueryExecutionArgs } from './query_execution_args.js';

interface ScriptQueryExecutionCallbacks {
    executeStatement: (
        args: QueryExecutionArgs,
        producesOutput: boolean,
    ) => Promise<arrow.Table | null>;
    onStatementStarted: (index: number, statementCount: number) => void;
    onStatementSucceeded: (index: number, statementCount: number) => void;
    setResultStream: (stream: QueryExecutionResponseStream | null) => void;
}

interface ExecuteScriptQueryArgs {
    execution: DashQLScriptExecution;
    queryArgs: QueryExecutionArgs;
    abortSignal: AbortSignal;
    logger: TracedLogger;
    notebookId: string;
    queryId: number;
    logTarget: string;
    callbacks: ScriptQueryExecutionCallbacks;
}

function assertValidUpdate(update: core.buffers.execution.ScriptExecutionUpdateT, fallback: string, target: string): void {
    if (update.protocolError !== core.buffers.execution.ScriptExecutionProtocolError.NONE) {
        throw new LoggableException(String(update.protocolErrorMessage ?? fallback), {}, target);
    }
}

export async function executeScriptQuery(args: ExecuteScriptQueryArgs): Promise<arrow.Table | null> {
    let operation: core.buffers.execution.ScriptExecutionUpdateT | null = null;
    let table: arrow.Table | null = null;

    try {
        operation = args.execution.start();
        assertValidUpdate(operation, 'Could not start script execution', args.logTarget);
        while (operation.pendingStatement != null) {
            args.abortSignal.throwIfAborted();
            const statement = operation.pendingStatement;
            args.callbacks.onStatementStarted(statement.index, statement.statementCount);
            args.logger.info(`Executing statement ${statement.index} of ${statement.statementCount}`, {
                notebookId: args.notebookId,
                query: args.queryId.toString(),
                statementId: statement.sourceStatementId.toString(),
            }, args.logTarget);

            const statementArgs = {
                ...args.queryArgs,
                query: String(statement.sql ?? ''),
                scriptExecution: undefined,
            };
            const result = await args.callbacks.executeStatement(statementArgs, statement.producesOutput);
            if (statement.producesOutput) table = result;
            args.callbacks.onStatementSucceeded(statement.index, statement.statementCount);

            operation = args.execution.resume(new core.buffers.execution.StatementResultT(
                statement.id,
                core.buffers.execution.StatementResultStatus.SUCCEEDED,
            ));
            assertValidUpdate(operation, 'Could not continue script execution', args.logTarget);
        }

        if (operation.snapshot?.phase !== core.buffers.execution.ScriptExecutionPhase.SUCCEEDED) {
            throw new LoggableException(String(operation.snapshot?.error ?? 'Script execution failed'), {}, args.logTarget);
        }
        return table;
    } catch (error: any) {
        const cancelled = args.abortSignal.aborted || error?.name === 'AbortError' || error?.message === 'AbortError';
        if (operation?.pendingStatement != null) {
            if (cancelled) {
                args.execution.cancel();
            } else {
                args.execution.resume(new core.buffers.execution.StatementResultT(
                    operation.pendingStatement.id,
                    core.buffers.execution.StatementResultStatus.FAILED,
                    stringifyError(error),
                ));
            }
        }
        throw error;
    } finally {
        args.callbacks.setResultStream(null);
        args.execution.destroy();
    }
}
