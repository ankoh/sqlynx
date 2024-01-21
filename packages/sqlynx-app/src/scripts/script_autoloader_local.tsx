import * as React from 'react';
import Immutable from 'immutable';

import { createGlobalScriptState } from './script_state_reducer';
import { useScriptSelector, useScriptState } from './script_state_provider';
import { CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info';
import { useSQLynx } from '../sqlynx_loader';
import { ScriptData, ScriptKey } from './script_state';
import { RESULT_OK } from '../utils';
import { ScriptLoadingStatus } from './script_loader';
import { TPCH_SCHEMA, EXAMPLE_SCRIPTS } from './example_scripts';

interface Props {
    children?: React.ReactElement;
}

const DEFAULT_BOARD_WIDTH = 800;
const DEFAULT_BOARD_HEIGHT = 600;

export const ScriptAutoloaderLocal: React.FC<Props> = (props: Props) => {
    const state = useScriptState();
    const instance = useSQLynx();
    const selectScript = useScriptSelector();

    React.useEffect(() => {
        // If there is no script state, fall back to a fresh local one
        if (!state && instance?.type == RESULT_OK) {
            const lnx = instance.value;

            const graph = lnx.createQueryGraphLayout();
            const catalog = lnx.createCatalog();
            const mainScript = lnx.createScript(catalog, ScriptKey.MAIN_SCRIPT);
            const schemaScript = lnx.createScript(catalog, ScriptKey.SCHEMA_SCRIPT);

            const mainScriptData: ScriptData = {
                scriptKey: ScriptKey.MAIN_SCRIPT,
                scriptVersion: 1,
                script: mainScript,
                metadata: EXAMPLE_SCRIPTS[2],
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
                    destroy: () => {},
                },
                statistics: Immutable.List(),
                cursor: null,
            };
            const schemaScriptData: ScriptData = {
                scriptKey: ScriptKey.SCHEMA_SCRIPT,
                scriptVersion: 1,
                script: schemaScript,
                metadata: TPCH_SCHEMA,
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
                    destroy: () => {},
                },
                statistics: Immutable.List(),
                cursor: null,
            };

            const scriptId = createGlobalScriptState({
                instance: instance.value,
                connectorInfo: CONNECTOR_INFOS[ConnectorType.LOCAL_SCRIPT],
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

            selectScript(scriptId);
        }
    }, [state, instance?.type]);
    return props.children;
};
