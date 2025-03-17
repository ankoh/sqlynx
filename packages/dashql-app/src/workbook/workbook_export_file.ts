import * as proto from '@ankoh/dashql-protobuf';

import { ConnectionState } from '../connection/connection_state.js';
import { WorkbookExportSettings } from './workbook_export_settings.js';
import { WorkbookState } from './workbook_state.js';
import { encodeConnectionParamsAsProto, getConnectionParamsFromDetails } from '../connection/connection_params.js';
import { encodeCatalogAsProto } from '../connection/catalog_export.js';

export function encodeWorkbookAsFile(workbookState: WorkbookState, connectionState: ConnectionState, settings: WorkbookExportSettings | null = null): proto.dashql_file.pb.File {
    // Get connection params
    const params = getConnectionParamsFromDetails(connectionState.details);

    // Pack the connection params
    if (params == null) {
        throw new Error("Connection params are null");
    }
    const paramsProto = encodeConnectionParamsAsProto(params, settings);

    // Collect the scripts
    const scripts: proto.dashql_workbook.pb.WorkbookScript[] = [];
    for (const k in workbookState.scripts) {
        const script = workbookState.scripts[k];
        scripts.push(new proto.dashql_workbook.pb.WorkbookScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
    const workbook = new proto.dashql_workbook.pb.Workbook({
        connectionParams: paramsProto,
        scripts: scripts
    });

    // Pack the file
    const file = new proto.dashql_file.pb.File({
        workbooks: [workbook]
    });

    // Encode the catalog if requested
    if (settings?.exportCatalog) {
        const catalogSnapshot = connectionState.catalog.createSnapshot();
        const catalogProto = encodeCatalogAsProto(catalogSnapshot);
        const c = new proto.dashql_file.pb.FileCatalog({
            connectionParams: paramsProto,
            catalog: catalogProto
        });
        file.catalogs.push(c);
    }
    return file;
}
