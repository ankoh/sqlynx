import * as React from 'react';
import Immutable from 'immutable';

import { registerSession } from './session_state_registry.js';
import { useSessionSelector } from './session_state_provider.js';
import { BRAINSTORM_MODE, CONNECTOR_INFOS, ConnectorType } from '../connectors/connector_info.js';
import { useSQLynxSetup } from '../sqlynx_loader.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { RESULT_OK } from '../utils/result.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { TPCH_SCHEMA, EXAMPLE_SCRIPTS } from './example_scripts.js';

export const DEFAULT_BOARD_WIDTH = 800;
export const DEFAULT_BOARD_HEIGHT = 600;

export function useBrainstormSessionSetup() {
    const setupSQLynx = useSQLynxSetup();
    const selectScript = useSessionSelector();

    return React.useCallback(async () => {
        // Try to setup SQLynx, abort if that fails
        const instance = await setupSQLynx("brainstorm_session");
        if (instance?.type !== RESULT_OK) {
            return;
        }

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
                destroy: () => { },
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
                destroy: () => { },
            },
            statistics: Immutable.List(),
            cursor: null,
        };

        const scriptId = registerSession({
            instance: instance.value,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.BRAINSTORM_MODE],
            connectorState: {
                type: BRAINSTORM_MODE,
                value: {}
            },
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
    }, [setupSQLynx, selectScript]);
};