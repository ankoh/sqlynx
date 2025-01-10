import * as sqlynx from '@ankoh/sqlynx-core';
import { SessionState } from './session_state.js';

export function findTableById(session: SessionState, table: sqlynx.ContextObjectID.Value): sqlynx.proto.Table | null {
    const scriptKey = sqlynx.ContextObjectID.getContext(table);
    const scriptData = session.scripts[scriptKey];
    if (!scriptData) {
        console.log("SCRIPT DATA NULL");
        return null;
    }
    if (!scriptData.processed.analyzed) {
        console.log("SCRIPT NOT ANALYZED");
        return null;
    }
    const reader = scriptData.processed.analyzed.read();
    const tableId = sqlynx.ContextObjectID.getObject(table);
    if (tableId >= reader.tablesLength()) {
        console.log("TABLE ID OUT OF BOUNDS");
        return null;
    }
    const tableProto = reader.tables(tableId);
    return tableProto;
}
