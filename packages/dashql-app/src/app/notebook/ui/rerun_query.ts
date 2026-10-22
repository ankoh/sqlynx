import type { QueryExecutor } from '../connections/query_executor.js';
import { QueryType } from '../connections/query_execution_state.js';
import { NotebookScripts, ScriptData, CATALOG_DID_UPDATE, REGISTER_QUERY, REGISTER_SCRIPT_RESULT, compileNotebookQuery, createScriptExecution } from '../scripts/notebook_scripts.js';
import { ensureNotebookScriptAnalyzed, ModifyNotebookScripts } from '../scripts/notebook_scripts_registry.js';
import { projectionForVisualizeQuery } from '../scripts/script_types.js';
import type { LoggerLike } from '../../../platform/logger/logger.js';
import { isNotebookExecutionRunning } from '../scripts/notebook_execution.js';

export function registerNotebookScriptQuery(
    scriptData: ScriptData,
    queryId: number,
    _queryText: string,
    execution: Promise<import('apache-arrow').Table | null>,
    modifyNotebookScripts: ModifyNotebookScripts,
): void {
    modifyNotebookScripts({ type: REGISTER_QUERY, value: [scriptData.scriptKey, queryId] });
    void execution.then(async table => {
        if (table != null) {
            await modifyNotebookScripts({ type: REGISTER_SCRIPT_RESULT, value: [scriptData.scriptKey, queryId] });
        }
    }).catch(() => { });
}

export function runNotebookScript(
    connectionId: string,
    notebookScripts: NotebookScripts,
    scriptData: ScriptData,
    executeQuery: QueryExecutor,
    modifyNotebookScripts: ModifyNotebookScripts,
    logger: LoggerLike,
): Promise<void> | void {
    if (isNotebookExecutionRunning(notebookScripts)) return;
    logger?.info('Notebook script execution requested', {
        connectionId,
        notebookId: notebookScripts.notebookId,
        scriptKey: scriptData.scriptKey.toString(),
        analysisOutdated: scriptData.analysisOutdated.toString(),
        analysisAvailable: scriptData.editorUpdate?.analysisAvailable.toString(),
        textVersion: scriptData.editorUpdate?.textVersion.toString(),
        nativeTextVersion: scriptData.scriptSession.getTextVersion?.().toString(),
        textLength: scriptData.scriptSession.getText?.().length.toString(),
    }, 'notebook_execution');
    if (scriptData.analysisOutdated) {
        return ensureNotebookScriptAnalyzed(notebookScripts, scriptData.scriptKey, modifyNotebookScripts)
            .then((analyzed) => {
                if (analyzed != null) {
                    logger?.info('Outdated notebook script analysis completed', {
                        notebookId: notebookScripts.notebookId,
                        scriptKey: scriptData.scriptKey.toString(),
                        analysisAvailable: analyzed.editorUpdate?.analysisAvailable.toString(),
                    }, 'notebook_execution');
                    executeNotebookScript(connectionId, analyzed, notebookScripts, executeQuery, modifyNotebookScripts, logger);
                } else {
                    logger?.warn('Notebook execution stopped because analysis returned no script', {
                        notebookId: notebookScripts.notebookId,
                        scriptKey: scriptData.scriptKey.toString(),
                    }, 'notebook_execution');
                }
            });
    }
    executeNotebookScript(connectionId, scriptData, notebookScripts, executeQuery, modifyNotebookScripts, logger);
}

function executeNotebookScript(
    connectionId: string,
    scriptData: ScriptData,
    notebookScripts: NotebookScripts,
    executeQuery: QueryExecutor,
    modifyNotebookScripts: ModifyNotebookScripts,
    logger: LoggerLike,
): void {
    if (isNotebookExecutionRunning(notebookScripts)) return;
    const compiled = compileNotebookQuery(scriptData, notebookScripts.connectorInfo.connectorType, logger);
    const queryText = compiled.sql;
    if (queryText.trim().length === 0) {
        logger?.warn('Notebook execution stopped because compiled query is empty', {
            scriptKey: scriptData.scriptKey.toString(),
        }, 'notebook_execution');
        return;
    }
    const [queryId, execution] = executeQuery(connectionId, {
        query: queryText,
        scriptExecution: createScriptExecution(scriptData, notebookScripts.connectorInfo.connectorType),
        // Scripts may reference the relations that a statement created or dropped
        onCatalogChanged: () => { void modifyNotebookScripts({ type: CATALOG_DID_UPDATE, value: null }); },
        analyzeResults: true,
        replaceComputationId: scriptData.latestResultQueryId === undefined
            ? scriptData.latestQueryId : scriptData.latestResultQueryId,
        // Notebooks opt into reusing cached results, a script decides if its query result can be cached
        cacheable: notebookScripts.settings.cacheQueryResults && compiled.cacheable,
        cacheSignature: compiled.cacheSignature,
        projection: projectionForVisualizeQuery(scriptData.annotations.visualizeQuery),
        metadata: {
            queryType: QueryType.USER_PROVIDED,
            title: 'Notebook Query',
            description: null,
            issuer: 'Query Rerun',
            userProvided: true,
        },
    });
    logger?.info('Notebook query allocated', {
        connectionId,
        scriptKey: scriptData.scriptKey.toString(),
        queryId: queryId.toString(),
        queryLength: queryText.length.toString(),
    }, 'notebook_execution');
    registerNotebookScriptQuery(scriptData, queryId, queryText, execution, modifyNotebookScripts);
}
