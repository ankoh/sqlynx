import * as React from 'react';
import Immutable from 'immutable';

import { useSQLynxSetup } from '../sqlynx_loader.js';
import { useSessionStateAllocator } from './session_state_registry.js';
import { useConnectionStateAllocator } from '../connectors/connection_registry.js';
import { createConnectionStatistics } from '../connectors/connection_statistics.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { BRAINSTORM_CONNECTOR, CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info.js';
import { RESULT_OK } from '../utils/result.js';
import { EXAMPLES } from './example_scripts.js';

export const DEFAULT_BOARD_WIDTH = 800;
export const DEFAULT_BOARD_HEIGHT = 600;

type SessionSetupFn = (abort: AbortSignal) => Promise<number | null>;

export function useBrainstormSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxSetup();
    const allocateSessionState = useSessionStateAllocator();
    const allocateConnectionId = useConnectionStateAllocator();

    return React.useCallback(async (abort: AbortSignal) => {
        // Try to setup SQLynx, abort if that fails
        const instance = await setupSQLynx("brainstorm_session");
        if (instance?.type !== RESULT_OK) {
            return null;
        }
        abort.throwIfAborted();

        const lnx = instance.value;

        const graph = lnx.createQueryGraphLayout();
        const catalog = lnx.createCatalog();
        const mainScript = lnx.createScript(catalog, ScriptKey.MAIN_SCRIPT);
        const schemaScript = lnx.createScript(catalog, ScriptKey.SCHEMA_SCRIPT);

        const mainScriptData: ScriptData = {
            scriptKey: ScriptKey.MAIN_SCRIPT,
            scriptVersion: 1,
            script: mainScript,
            metadata:  EXAMPLES.tpch.queries[1],
            loading: {
                status: ScriptLoadingStatus.PENDING,
                error: null,
                startedAt: null,
                finishedAt: null,
            },
            processed: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: () => { },
            },
            statistics: Immutable.List(),
            cursor: null,
        };
        const schemaScriptData: ScriptData = {
            scriptKey: ScriptKey.SCHEMA_SCRIPT,
            scriptVersion: 1,
            script: schemaScript,
            metadata:  EXAMPLES.tpch.schema,
            loading: {
                status: ScriptLoadingStatus.PENDING,
                error: null,
                startedAt: null,
                finishedAt: null,
            },
            processed: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: () => { },
            },
            statistics: Immutable.List(),
            cursor: null,
        };

        const scriptId = allocateSessionState({
            instance: instance.value,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.BRAINSTORM_MODE],
            connectionId: allocateConnectionId({
                type: BRAINSTORM_CONNECTOR,
                value: {
                    stats: createConnectionStatistics()
                }
            }),
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: mainScriptData,
                [ScriptKey.SCHEMA_SCRIPT]: schemaScriptData,
            },
            nextCatalogUpdateId: 1,
            catalogUpdateRequests: Immutable.Map(),
            catalogUpdates: Immutable.Map(),
            catalog,
            graph,
            graphConfig: {
                boardWidth: DEFAULT_BOARD_WIDTH,
                boardHeight: DEFAULT_BOARD_HEIGHT,
                cellWidth: 120,
                cellHeight: 64,
                tableWidth: 180,
                tableHeight: 36,
            },
            graphLayout: null,
            graphViewModel: {
                nodes: [],
                nodesByTable: new Map(),
                edges: new Map(),
                boundaries: {
                    minX: 0,
                    maxX: 0,
                    minY: 0,
                    maxY: 0,
                    totalWidth: 0,
                    totalHeight: 0,
                },
            },
            userFocus: null,
            queryExecutionRequested: false,
            queryExecutionState: null,
            queryExecutionResult: null,
        });
        return scriptId;

    }, [setupSQLynx, allocateSessionState]);
};
