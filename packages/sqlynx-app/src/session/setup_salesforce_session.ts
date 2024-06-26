import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info.js';
import { DEFAULT_BOARD_HEIGHT, DEFAULT_BOARD_WIDTH } from './setup_serverless_session.js';
import { RESULT_OK } from '../utils/result.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { generateBlankScript } from './script_metadata.js';
import { useSQLynxSetup } from '../sqlynx_loader.js';
import { useSessionStateAllocator } from './session_state_registry.js';
import { createSalesforceConnectorState } from '../connectors/salesforce_connection_state.js';
import { useConnectionStateAllocator } from '../connectors/connection_registry.js';

type SessionSetupFn = (abort?: AbortSignal) => Promise<number>;

export function useSalesforceSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxSetup();
    const allocateConnection = useConnectionStateAllocator();
    const allocateSessionState = useSessionStateAllocator();

    return React.useCallback(async (signal?: AbortSignal) => {
        const instance = await setupSQLynx("salesforce_session");
        if (instance?.type != RESULT_OK) throw instance.error;
        signal?.throwIfAborted();

        const lnx = instance.value;
        const connectionState = createSalesforceConnectorState(lnx);
        const connectionId = allocateConnection(connectionState);
        const graph = lnx.createQueryGraphLayout();
        const mainScript = lnx.createScript(connectionState.catalog, ScriptKey.MAIN_SCRIPT);

        const mainScriptData: ScriptData = {
            scriptKey: ScriptKey.MAIN_SCRIPT,
            scriptVersion: 1,
            script: mainScript,
            metadata: generateBlankScript(),
            loading: {
                status: ScriptLoadingStatus.SUCCEEDED,
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
            connectorInfo: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
            connectionId: connectionId,
            connectionCatalog: connectionState.catalog,
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: mainScriptData,
            },
            runningQueries: new Set(),
            finishedQueries: [],
            editorQuery: null,
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
        });
    }, [setupSQLynx, allocateSessionState]);
};
