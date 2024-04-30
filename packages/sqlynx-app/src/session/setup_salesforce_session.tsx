import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info.js';
import { DEFAULT_BOARD_HEIGHT, DEFAULT_BOARD_WIDTH } from './setup_brainstorm_session.js';
import { FULL_CATALOG_REFRESH } from '../connectors/catalog_update.js';
import { useSalesforceAPI, useSalesforceConnectionId } from '../connectors/salesforce_connector.js';
import { asSalesforceConnection } from '../connectors/connection_state.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { RESULT_OK } from '../utils/result.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { UPDATE_CATALOG } from './session_state_reducer.js';
import { useSessionStateAllocator, useSessionState } from './session_state_registry.js';
import { generateBlankScript } from './script_metadata.js';
import { useSQLynxSetup } from '../sqlynx_loader.js';

type SessionSetupFn = (abort: AbortSignal) => Promise<number | null>;

export function useSalesforceSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxSetup();
    const allocateSessionState = useSessionStateAllocator();
    const sfApi = useSalesforceAPI();
    const sfConnectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState(sfConnectionId);
    const sfConnection = asSalesforceConnection(connection);

    const [connectorScriptId, setConnectorScriptId] = React.useState<number | null>(null);
    const [_sessionState, sessionStateDispatch] = useSessionState(connectorScriptId);

    return React.useCallback(async (signal: AbortSignal) => {
        if (!sfApi || !sfConnection || !sfConnection.auth.dataCloudAccessToken) return null;

        // Setup SQLynx lazily.
        // Note that this means the WASM module will only be set up when da data cloud token is provided.
        const instance = await setupSQLynx("salesforce_session");
        if (instance?.type != RESULT_OK || signal.aborted) return null;

        // First time we use this connector?
        // Setup a new script then and select it.
        if (connectorScriptId == null) {
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

            const scriptId = allocateSessionState({
                instance: instance.value,
                connectorInfo: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
                connectionId: sfConnectionId,
                scripts: {
                    [ScriptKey.MAIN_SCRIPT]: mainScriptData,
                },
                nextCatalogUpdateId: 2,
                catalogUpdateRequests: Immutable.Map([
                    [
                        1,
                        {
                            type: FULL_CATALOG_REFRESH,
                            value: null,
                        },
                    ],
                ]),
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
            setConnectorScriptId(scriptId);
            return scriptId;
        } else {
            // Otherwise, the access token just changed.
            // Do a full catalog refresh
            sessionStateDispatch({
                type: UPDATE_CATALOG,
                value: {
                    type: FULL_CATALOG_REFRESH,
                    value: null,
                },
            });
            return connectorScriptId;
        }
    }, [sfApi, sfConnection?.auth.dataCloudAccessToken, setupSQLynx]);
};
