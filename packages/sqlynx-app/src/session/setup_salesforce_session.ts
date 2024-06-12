import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info.js';
import { DEFAULT_BOARD_HEIGHT, DEFAULT_BOARD_WIDTH } from './setup_serverless_session.js';
import { RESULT_OK } from '../utils/result.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { generateBlankScript } from './script_metadata.js';
import { useSQLynxSetup } from '../sqlynx_loader.js';
import { useSalesforceConnectionId } from '../connectors/salesforce_connector.js';
import { useSessionStateAllocator } from './session_state_registry.js';

type SessionSetupFn = (abort?: AbortSignal) => Promise<number>;

export function useSalesforceSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxSetup();
    const allocateSessionState = useSessionStateAllocator();
    const connectionId = useSalesforceConnectionId();

    return React.useCallback(async (signal?: AbortSignal) => {
        const instance = await setupSQLynx("salesforce_session");
        if (instance?.type != RESULT_OK) throw instance.error;
        signal?.throwIfAborted();

        const lnx = instance.value;
        const graph = lnx.createQueryGraphLayout();
        const catalog = lnx.createCatalog();
        const mainScript = lnx.createScript(catalog, ScriptKey.MAIN_SCRIPT);

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
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: mainScriptData,
            },
            nextCatalogUpdateId: 2,
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
