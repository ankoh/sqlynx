import * as React from 'react';
import Immutable from 'immutable';

import { CONNECTOR_INFOS, ConnectorType } from '../../connectors/connector_info.js';
import { RESULT_OK } from '../../utils/result.js';
import { ScriptData, ScriptKey } from '../../session/session_state.js';
import { ScriptLoadingStatus } from '../../session/script_loader.js';
import { generateBlankScript } from '../../session/script_metadata.js';
import { useSQLynxCoreSetup } from '../../core_provider.js';
import { useSessionStateAllocator } from '../../session/session_state_registry.js';
import { useConnectionStateAllocator } from '../../connectors/connection_registry.js';
import { createHyperGrpcConnectionState } from './hyper_connection_state.js';

type SessionSetupFn = (abort?: AbortSignal) => Promise<number>;

export function useHyperSessionSetup(): SessionSetupFn {
    const setupSQLynx = useSQLynxCoreSetup();
    const allocateConnection = useConnectionStateAllocator();
    const allocateSessionState = useSessionStateAllocator();

    return React.useCallback(async (signal?: AbortSignal) => {
        const instance = await setupSQLynx("hyper_session");
        if (instance?.type != RESULT_OK) throw instance.error;
        signal?.throwIfAborted();

        const lnx = instance.value;
        const connectionState = createHyperGrpcConnectionState(lnx);
        const connectionId = allocateConnection(connectionState);
        const mainScript = lnx.createScript(connectionState.catalog, ScriptKey.MAIN_SCRIPT);

        const mainScriptData: ScriptData = {
            scriptKey: ScriptKey.MAIN_SCRIPT,
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
            completion: null,
            selectedCompletionCandidate: null,
        };

        return allocateSessionState({
            instance: instance.value,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER_GRPC],
            connectionId,
            connectionCatalog: connectionState.catalog,
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: mainScriptData,
            },
            runningQueries: new Set(),
            finishedQueries: [],
            editorQuery: null,
            userFocus: null,
        });
    }, [setupSQLynx, allocateSessionState]);
};
