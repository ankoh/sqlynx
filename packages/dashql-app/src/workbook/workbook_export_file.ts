import * as pb from '@ankoh/dashql-protobuf';

import { ConnectionState } from '../connection/connection_state.js';
import { WorkbookExportSettings } from './workbook_export_settings.js';
import { WorkbookState } from './workbook_state.js';
import { encodeConnectionParamsAsProto, getConnectionParamsFromStateDetails } from '../connection/connection_params.js';
import { encodeCatalogAsProto } from '../connection/catalog_export.js';

export function encodeWorkbookAsFile(workbookState: WorkbookState, connectionState: ConnectionState, settings: WorkbookExportSettings | null = null): pb.dashql.file.File {
    // Get connection params
    const params = getConnectionParamsFromStateDetails(connectionState.details);

    // Pack the connection params
    if (params == null) {
        throw new Error("Connection params are null");
    }
    const paramsProto = encodeConnectionParamsAsProto(params, settings);

    // Collect the scripts
    const scripts: pb.dashql.workbook.WorkbookScript[] = [];
    for (const k in workbookState.scripts) {
        const script = workbookState.scripts[k];
        scripts.push(new pb.dashql.workbook.WorkbookScript({
            scriptId: script.scriptKey as number,
            scriptText: script.script?.toString() ?? "",
        }));
    }
    const workbook = new pb.dashql.workbook.Workbook({
        connectionParams: paramsProto,
        scripts: scripts
    });

    // Pack the file
    const file = new pb.dashql.file.File({
        workbooks: [workbook]
    });

    // Encode the catalog if requested
    if (settings?.exportCatalog) {
        const catalogSnapshot = connectionState.catalog.createSnapshot();
        const catalogProto = encodeCatalogAsProto(catalogSnapshot);
        const c = new pb.dashql.file.FileCatalog({
            connectionParams: paramsProto,
            catalog: catalogProto
        });
        file.catalogs.push(c);
    }
    return file;
}
