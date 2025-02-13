import * as proto from '@ankoh/sqlynx-protobuf';

import { SessionState } from './session_state.js';
import { ConnectionState } from '../connectors/connection_state.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { buildConnectorParams } from '../connectors/connection_params.js';

export enum SessionLinkTarget {
    NATIVE,
    WEB
}

export function generateSessionSetupUrl(sessionState: SessionState, connection: ConnectionState, target: SessionLinkTarget): URL {
    const connectorParams = buildConnectorParams(connection.details);

    // Collect the scripts
    const scripts: proto.sqlynx_session.pb.SessionScript[] = [];
    for (const k in sessionState.scripts) {
        const script = sessionState.scripts[k];
        scripts.push(new proto.sqlynx_session.pb.SessionScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
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

export function encodeSessionSetupUrl(setup: proto.sqlynx_session.pb.SessionSetup, target: SessionLinkTarget): URL {
    const eventData = new proto.sqlynx_app_event.pb.AppEventData({
        data: {
            case: "sessionSetup",
            value: setup
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
