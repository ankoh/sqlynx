import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../../connectors/connector_info.js';
import { EXAMPLES } from '../../session/example_scripts.js';
import { RESULT_OK } from '../../utils/result.js';
import { ScriptData } from '../../session/session_state.js';
import { ScriptLoadingStatus } from '../../session/script_loader.js';
import { useConnectionStateAllocator } from '../../connectors/connection_registry.js';
import { useSQLynxCoreSetup } from '../../core_provider.js';
import { useSessionStateAllocator } from '../../session/session_state_registry.js';
import { createDemoConnectionState } from '../demo/demo_connection_state.js';

export const DEFAULT_BOARD_WIDTH = 800;
export const DEFAULT_BOARD_HEIGHT = 600;

type SessionSetupFn = (abort?: AbortSignal) => Promise<number>;

export function useDemoSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxCoreSetup();
    const allocateConnection = useConnectionStateAllocator();
    const allocateSessionState = useSessionStateAllocator();

    return React.useCallback(async (signal?: AbortSignal) => {
        const instance = await setupSQLynx("demo_session");
        if (instance?.type != RESULT_OK) throw instance.error;
        signal?.throwIfAborted();

        const lnx = instance.value;
        const connectionState = createDemoConnectionState(lnx);
        const connectionId = allocateConnection(connectionState);
        const mainScript = lnx.createScript(connectionState.catalog, 1);
        const schemaScript = lnx.createScript(connectionState.catalog, 2);

        const mainScriptData: ScriptData = {
            scriptKey: 1,
            script: mainScript,
            metadata: EXAMPLES.TPCH.queries[1],
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
            outdatedAnalysis: true,
            statistics: Immutable.List(),
            cursor: null,
            completion: null,
            selectedCompletionCandidate: null,
        };
        const schemaScriptData: ScriptData = {
            scriptKey: 2,
            script: schemaScript,
            metadata: EXAMPLES.TPCH.schema,
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
            outdatedAnalysis: true,
            statistics: Immutable.List(),
            cursor: null,
            completion: null,
            selectedCompletionCandidate: null,
        };

        return allocateSessionState({
            instance: instance.value,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.DEMO],
            connectionId: connectionId,
            connectionCatalog: connectionState.catalog,
            scripts: {
                [mainScriptData.scriptKey]: mainScriptData,
                [schemaScriptData.scriptKey]: schemaScriptData,
            },
            workbookEntries: [{
                scriptKey: mainScriptData.scriptKey,
                queryId: null,
                title: null,
            }, {
                scriptKey: schemaScriptData.scriptKey,
                queryId: null,
                title: null,
            }],
            selectedWorkbookEntry: 0,
            userFocus: null,
        });
    }, [setupSQLynx, allocateSessionState]);
}
