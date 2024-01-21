import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info';
import { DEFAULT_BOARD_HEIGHT, DEFAULT_BOARD_WIDTH } from './script_autoloader_local';
import { FULL_CATALOG_REFRESH } from '../connectors/catalog_update';
import { RESULT_OK } from '../utils';
import { ScriptData, ScriptKey } from './script_state';
import { ScriptLoadingStatus } from './script_loader';
import { UPDATE_CATALOG } from './script_state_reducer';
import { createGlobalScriptState, useGlobalScriptState } from './global_script_state';
import { generateBlankScript } from './script_metadata';
import { useSQLynx } from '../sqlynx_loader';
import { useSalesforceAPI } from '../connectors/salesforce_connector';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import { useScriptSelector, useSelectedScriptStateDispatch } from './script_state_provider';

interface Props {
    children?: React.ReactElement;
}

export const ScriptAutoloaderSalesforce: React.FC<Props> = (props: Props) => {
    const instance = useSQLynx();
    const connector = useSalesforceAPI();
    const authState = useSalesforceAuthState();
    const selectScript = useScriptSelector();

    const [connectorScriptId, setConnectorScriptId] = React.useState<number | null>(null);
    const [_scriptState, scriptStateDispatch] = useGlobalScriptState(connectorScriptId);

    React.useEffect(() => {
        if (!connector || !authState.dataCloudAccessToken || instance?.type != RESULT_OK) return;

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
                    destroy: () => {},
                },
                statistics: Immutable.List(),
                cursor: null,
            };

            const scriptId = createGlobalScriptState({
                instance: instance.value,
                connectorInfo: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
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
            selectScript(scriptId);
        } else {
            // Otherwise, the access token just changed.
            // Do a full catalog refresh
            scriptStateDispatch({
                type: UPDATE_CATALOG,
                value: {
                    type: FULL_CATALOG_REFRESH,
                    value: null,
                },
            });
        }
    }, [connector, authState.dataCloudAccessToken, instance]);
    return props.children;
};
