import * as pb from '@ankoh/dashql-protobuf';

import { WorkbookState } from './workbook_state.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { ConnectionParamsVariant, encodeConnectionParamsAsProto } from '../connection/connection_params.js';
import { WorkbookExportSettings } from './workbook_export_settings.js';

export function encodeWorkbookAsProto(workbookState: WorkbookState, connectionParams: ConnectionParamsVariant, settings: WorkbookExportSettings | null = null): pb.dashql.workbook.Workbook {
    // Build the connector params
    const params = encodeConnectionParamsAsProto(connectionParams, settings);

    // Collect the scripts
    const scripts: pb.dashql.workbook.WorkbookScript[] = [];
    for (const k in workbookState.scripts) {
        const script = workbookState.scripts[k];
        scripts.push(new pb.dashql.workbook.WorkbookScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
    const setup = new pb.dashql.workbook.Workbook({
        connectionParams: (params == null) ? undefined : params,
        scripts: scripts
    });
    return setup;
}

export enum WorkbookLinkTarget {
    NATIVE,
    WEB
}

export function encodeWorkbookProtoAsUrl(setup: pb.dashql.workbook.Workbook, target: WorkbookLinkTarget): URL {
    const eventData = new pb.dashql.app_event.AppEventData({
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
