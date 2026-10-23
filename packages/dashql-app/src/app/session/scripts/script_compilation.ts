import * as core from '@ankoh/dashql-core';

import { ConnectorType } from '../../connections/connector_info.js';
import { LoggerLike, LoggableException } from '../../../platform/logger/logger.js';
import type { ScriptData } from './session_scripts.js';
import type { ResolvedVisualizeQuery } from './script_types.js';

const LOG_CTX = 'script_compilation';

export interface CompiledSessionQuery {
    sql: string;
    cacheSignature: string;
    cacheable: boolean;
}

/// Compile a script into executable SQL and cache metadata.
///
/// Statement classification, executable SQL extraction, and VISUALIZE
/// source extraction all happen in dashql-core.
export function compileSessionQuery(
    scriptData: ScriptData,
    connectorType: ConnectorType,
    logger?: LoggerLike,
): CompiledSessionQuery {
    logger?.debug('Compiling script for query execution', {
        scriptKey: scriptData.scriptKey.toString(),
        fileName: scriptData.fileName,
        textVersion: scriptData.editorUpdate?.textVersion.toString(),
        stateRevision: scriptData.editorUpdate?.stateRevision.toString(),
        nativeTextVersion: scriptData.scriptSession.getTextVersion?.().toString(),
        analysisOutdated: scriptData.analysisOutdated.toString(),
        analysisAvailable: scriptData.editorUpdate?.analysisAvailable.toString(),
        textLength: scriptData.scriptSession.getText?.().length.toString(),
    }, LOG_CTX);
    const compiled = scriptData.scriptSession.compileQuery(executionFormattingConfig(connectorType));
    try {
        const reader = compiled.read();
        const sql = reader.sql() ?? '';
        if (reader.errorsLength() > 0 && sql.length > 0) {
            logger?.warn('Passing unparseable SQL through to the remote database', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                diagnostic: reader.errors(0)?.message() ?? '',
            }, LOG_CTX);
        } else if (reader.errorsLength() > 0) {
            const error = reader.errors(0);
            throw new LoggableException(error?.message() ?? 'Could not compile query', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                errorCode: error?.code().toString(),
            }, LOG_CTX);
        }
        if (sql.trim().length == 0) {
            throw new LoggableException('Compile query is empty', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                script: scriptData.scriptSession.getText(),
            }, LOG_CTX);
        }
        logger?.debug('Compiled script for query execution', {
            scriptKey: scriptData.scriptKey.toString(),
            sqlLength: sql.length.toString(),
        }, LOG_CTX);
        return {
            sql,
            cacheSignature: reader.cacheSignature() ?? '',
            cacheable: reader.cacheable(),
        };
    } finally {
        compiled.destroy();
    }
}

export function createScriptExecution(scriptData: ScriptData, connectorType: ConnectorType): core.DashQLScriptExecution {
    return scriptData.scriptSession.startExecution(executionFormattingConfig(connectorType));
}

function executionFormattingConfig(connectorType: ConnectorType): core.buffers.formatting.FormattingConfigT {
    return new core.buffers.formatting.FormattingConfigT(
        connectorType === ConnectorType.TRINO
            ? core.buffers.formatting.FormattingDialect.TRINO
            : core.buffers.formatting.FormattingDialect.HYPER,
        core.buffers.formatting.FormattingMode.INLINE,
        120,
        2,
        false,
    );
}

export function compileVisualizeQuery(scriptSession: core.DashQLScriptSession, connectorType: ConnectorType,
    logger?: LoggerLike): ResolvedVisualizeQuery | null {
    const compiled = scriptSession.compileQuery(executionFormattingConfig(connectorType));
    try {
        const reader = compiled.read();
        if (reader.errorsLength() > 0 ||
            reader.kind() !== core.buffers.execution.ScriptCompilationStatementKind.VISUALIZE) {
            return null;
        }
        const sql = reader.sql();
        const visualization = reader.visualization();
        if (!sql || !visualization) return null;
        logger?.debug('Compiled visualization for execution', { sql }, LOG_CTX);
        return resolveCompiledVisualization(sql, visualization.unpack());
    } finally {
        compiled.destroy();
    }
}

export function resolveCompiledVisualization(
    sql: string,
    visualization: core.buffers.execution.CompiledVisualizationT,
): ResolvedVisualizeQuery | null {
    const dashboardSpec = visualization.dashboard ?? null;
    switch (visualization.renderer) {
        case 'umap': {
            const umapSpec = visualization.umapSpec;
            return umapSpec && typeof umapSpec.vectorColumn === 'string' && umapSpec.vectorColumn.length > 0
                ? { renderer: 'umap', sql, umapSpec, dashboardSpec }
                : null;
        }
        case 'markdown': {
            const markdownSpec = visualization.markdownSpec;
            return markdownSpec?.document ? { renderer: 'markdown', sql, markdownSpec, dashboardSpec } : null;
        }
        case 'vegalite': {
            const raw = visualization.vegaliteSpec;
            if (!raw) return null;
            try {
                return { renderer: 'vegalite', sql, vegaLiteSpec: JSON.parse(String(raw)), dashboardSpec };
            } catch {
                return null;
            }
        }
        case 'table':
            return { renderer: 'table', sql, dashboardSpec };
        default:
            return null;
    }
}
