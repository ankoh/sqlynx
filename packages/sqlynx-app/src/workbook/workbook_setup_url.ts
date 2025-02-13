import * as proto from '@ankoh/sqlynx-protobuf';

import { WorkbookState } from './workbook_state.js';
import { ConnectionState } from '../connectors/connection_state.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { buildConnectorParams } from '../connectors/connection_params.js';

export enum WorkbookLinkTarget {
    NATIVE,
    WEB
}

export function generateWorkbookUrl(workbookState: WorkbookState, connection: ConnectionState, target: WorkbookLinkTarget): URL {
    const connectorParams = buildConnectorParams(connection.details);

    // Collect the scripts
    const scripts: proto.sqlynx_workbook.pb.WorkbookScript[] = [];
    for (const k in workbookState.scripts) {
        const script = workbookState.scripts[k];
        scripts.push(new proto.sqlynx_workbook.pb.WorkbookScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
    const eventData = new proto.sqlynx_app_event.pb.AppEventData({
        data: {
            case: "workbook",
            value: new proto.sqlynx_workbook.pb.Workbook({
                connectorParams: (connectorParams == null) ? undefined : connectorParams,
                scripts: scripts
            })
        }
    });
    const eventDataBytes = eventData.toBinary();
    const eventDataBase64 = BASE64_CODEC.encode(eventDataBytes.buffer);

    switch (target) {
        case WorkbookLinkTarget.WEB:
            return new URL(`${process.env.SQLYNX_APP_URL!}?data=${eventDataBase64}`);
        case WorkbookLinkTarget.NATIVE:
            return new URL(`sqlynx://localhost?data=${eventDataBase64}`);
    };
}

export function encodeWorkbookAsUrl(setup: proto.sqlynx_workbook.pb.Workbook, target: WorkbookLinkTarget): URL {
    const eventData = new proto.sqlynx_app_event.pb.AppEventData({
        data: {
            case: "workbook",
            value: setup
        }
    });
    const eventDataBytes = eventData.toBinary();
    const eventDataBase64 = BASE64_CODEC.encode(eventDataBytes.buffer);

    switch (target) {
        case WorkbookLinkTarget.WEB:
            return new URL(`${process.env.SQLYNX_APP_URL!}?data=${eventDataBase64}`);
        case WorkbookLinkTarget.NATIVE:
            return new URL(`sqlynx://localhost?data=${eventDataBase64}`);
    };
}
