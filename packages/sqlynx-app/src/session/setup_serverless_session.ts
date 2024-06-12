import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType, SERVERLESS_CONNECTOR } from '../connectors/connector_info.js';
import { EXAMPLES } from './example_scripts.js';
import { RESULT_OK } from '../utils/result.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { createConnectionStatistics } from '../connectors/connection_statistics.js';
import { useConnectionStateAllocator } from '../connectors/connection_registry.js';
import { useSQLynxSetup } from '../sqlynx_loader.js';
import { useSessionStateAllocator } from './session_state_registry.js';

export const DEFAULT_BOARD_WIDTH = 800;
export const DEFAULT_BOARD_HEIGHT = 600;

type SessionSetupFn = (abort?: AbortSignal) => Promise<number>;

export function useServerlessSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxSetup();
    const allocateSessionState = useSessionStateAllocator();
    const allocateConnectionId = useConnectionStateAllocator();

    return React.useCallback(async (signal?: AbortSignal) => {
        const instance = await setupSQLynx("serverless_session");
        if (instance?.type != RESULT_OK) throw instance.error;
        signal?.throwIfAborted();

        const lnx = instance.value;
        const graph = lnx.createQueryGraphLayout();
        const catalog = lnx.createCatalog();
        const mainScript = lnx.createScript(catalog, ScriptKey.MAIN_SCRIPT);
        const schemaScript = lnx.createScript(catalog, ScriptKey.SCHEMA_SCRIPT);

        const mainScriptData: ScriptData = {
            scriptKey: ScriptKey.MAIN_SCRIPT,
            scriptVersion: 1,
            script: mainScript,
            metadata:  EXAMPLES.TPCH.queries[1],
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
            metadata:  EXAMPLES.TPCH.schema,
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

        return allocateSessionState({
            instance: instance.value,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.SERVERLESS],
            connectionId: allocateConnectionId({
                type: SERVERLESS_CONNECTOR,
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

    }, [setupSQLynx, allocateSessionState]);
};
