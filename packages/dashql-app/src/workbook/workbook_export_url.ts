import * as proto from '@ankoh/dashql-protobuf';

import { WorkbookState } from './workbook_state.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { ConnectionParamsVariant, encodeConnectionParams } from '../connection/connection_params.js';
import { WorkbookExportSettings } from './workbook_export_settings.js';

export function encodeWorkbookAsProto(workbookState: WorkbookState, connectionParams: ConnectionParamsVariant, settings: WorkbookExportSettings | null = null): proto.dashql_workbook.pb.Workbook {
    // Build the connector params
    const params = encodeConnectionParams(connectionParams, settings);

    // Collect the scripts
    const scripts: proto.dashql_workbook.pb.WorkbookScript[] = [];
    for (const k in workbookState.scripts) {
        const script = workbookState.scripts[k];
        scripts.push(new proto.dashql_workbook.pb.WorkbookScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
    const setup = new proto.dashql_workbook.pb.Workbook({
        connectionParams: (params == null) ? undefined : params,
        scripts: scripts
    });
    return setup;
}

export enum WorkbookLinkTarget {
    NATIVE,
    WEB
}

export function encodeWorkbookProtoAsUrl(setup: proto.dashql_workbook.pb.Workbook, target: WorkbookLinkTarget): URL {
    const eventData = new proto.dashql_app_event.pb.AppEventData({
        data: {
            case: "workbook",
            value: setup
        }
    });
    const eventDataBytes = eventData.toBinary();
    const eventDataBase64 = BASE64_CODEC.encode(eventDataBytes.buffer);

    switch (target) {
        case WorkbookLinkTarget.WEB:
            return new URL(`${process.env.DASHQL_APP_URL!}?data=${eventDataBase64}`);
        case WorkbookLinkTarget.NATIVE:
            return new URL(`dashql://localhost?data=${eventDataBase64}`);
    };
}
