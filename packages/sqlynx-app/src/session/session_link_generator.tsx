import * as React from 'react';
import * as LZString from 'lz-string';

import { ScriptData, ScriptKey } from './session_state.js';
import { ConnectorType } from '../connectors/connector_info.js';
import { SalesforceConnectorState } from '../connectors/connection_state.js';
import { useConnectionState } from '../connectors/connection_manager.js';
import { useThrottledMemo } from '../utils/throttle.js';
import { useActiveSessionState } from './session_state_provider.js';
import { useSalesforceConnectionId } from '../connectors/salesforce_auth_state.js';
import { writeBrainstormConnectorParams, writeHyperConnectorParams, writeSalesforceConnectorParams } from '../connectors/connector_url_params.js';

/// Encode a script as compressed base64 text
function encodeScript(url: URLSearchParams, key: string, data: ScriptData) {
    if (data.script) {
        const text = data.script.toString();
        const textBase64 = LZString.compressToBase64(text);
        url.set(key, encodeURIComponent(textBase64));
    }
};

export interface SessionLinks {
    privateDeepLink: URL;
    privateWebLink: URL;
    publicWebLink: URL;
};

/// Hook to maintain generated links for a session
function generateSessionLinks(): SessionLinks {
    const scriptState = useActiveSessionState();
    const connectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState<SalesforceConnectorState>(connectionId);

    return useThrottledMemo(() => {
        const appUrl = process.env.SQLYNX_APP_URL!;
        const privateParams = new URLSearchParams();
        const publicParams = new URLSearchParams();
        switch (scriptState?.connectorInfo.connectorType ?? ConnectorType.BRAINSTORM_MODE) {
            case ConnectorType.BRAINSTORM_MODE:
                writeBrainstormConnectorParams(privateParams, publicParams);
                break;
            case ConnectorType.HYPER_DATABASE:
                writeHyperConnectorParams(privateParams, publicParams);
                break;
            case ConnectorType.SALESFORCE_DATA_CLOUD:
                writeSalesforceConnectorParams(privateParams, publicParams, connection);
                break;
        }
        const mainScript = scriptState?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
        const schemaScript = scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null;
        if (mainScript?.script) {
            encodeScript(publicParams, 'script', mainScript);
        }
        if (schemaScript?.script) {
            encodeScript(privateParams, 'schema', schemaScript);
        }
        const privateAndPublicParams = new URLSearchParams(publicParams);
        for (const [k, v] of privateParams) {
            privateAndPublicParams.set(k, v);
        }
        return {
            privateDeepLink: new URL(`sqlynx://localhost?${privateAndPublicParams.toString()}`),
            privateWebLink: new URL(`${appUrl}?${privateAndPublicParams.toString()}`),
            publicWebLink: new URL(`${appUrl}?${publicParams.toString()}`)
        };
    }, [
        connection,
        scriptState?.scripts[ScriptKey.MAIN_SCRIPT],
        scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT],
    ], 500);
}

const SESSION_LINKS_CTX = React.createContext<SessionLinks | null>(null);

export const SessionLinkGenerator: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const links = generateSessionLinks();
    return (
        <SESSION_LINKS_CTX.Provider value={links}>
            {props.children}
        </SESSION_LINKS_CTX.Provider>
    );
};

/// Use the session urls
export const useSessionLinks = () => React.useContext(SESSION_LINKS_CTX);
