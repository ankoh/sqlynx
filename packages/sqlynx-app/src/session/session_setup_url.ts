import * as proto from '@ankoh/sqlynx-pb';

import { SessionState, ScriptData, ScriptKey } from './session_state.js';
import { ConnectionState } from '../connectors/connection_state.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { buildConnectorParams } from '../connectors/connection_params.js';

export enum SessionLinkTarget {
    NATIVE,
    WEB
}

export function generateSessionSetupUrl(sessionState: SessionState, connection: ConnectionState, target: SessionLinkTarget): URL {
    const connectorParams = buildConnectorParams(connection.details);
    const scripts: proto.sqlynx_session.pb.SessionScript[] = [];
    const addScript = (script: ScriptData | null) => {
        if (script != null) {
            scripts.push(new proto.sqlynx_session.pb.SessionScript({
                scriptId: script.scriptKey as number,
                scriptText: script.script?.toString() ?? "",
            }));
        }
    };
    addScript(sessionState?.scripts[ScriptKey.MAIN_SCRIPT] ?? null);
    addScript(sessionState?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null);

    const eventData = new proto.sqlynx_app_event.pb.AppEventData({
        data: {
            case: "sessionSetup",
            value: new proto.sqlynx_session.pb.SessionSetup({
                connectorParams: (connectorParams == null) ? undefined : connectorParams,
                scripts: scripts
            })
        }
    });
    const eventDataBytes = eventData.toBinary();
    const eventDataBase64 = BASE64_CODEC.encode(eventDataBytes.buffer);

    switch (target) {
        case SessionLinkTarget.WEB:
            return new URL(`${process.env.SQLYNX_APP_URL!}?data=${eventDataBase64}`);
        case SessionLinkTarget.NATIVE:
            return new URL(`sqlynx://localhost?data=${eventDataBase64}`);
    };
}
