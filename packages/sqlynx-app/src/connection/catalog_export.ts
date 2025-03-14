import * as proto from '@ankoh/sqlynx-protobuf';

import { ConnectionState } from '../connection/connection_state.js';
import { WorkbookExportSettings } from './workbook_export_settings.js';

export function encodeWorkbookAsFile(connectionState: ConnectionState, settings: WorkbookExportSettings | null = null): proto.sqlynx_catalog.pb.Catalog {

}
