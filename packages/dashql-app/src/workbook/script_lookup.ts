import * as dashql from '@ankoh/dashql-core';
import { WorkbookState } from './workbook_state.js';

export function findTableById(workbook: WorkbookState, table: dashql.ContextObjectID.Value): dashql.buffers.Table | null {
    const scriptKey = dashql.ContextObjectID.getContext(table);
    const scriptData = workbook.scripts[scriptKey];
    if (!scriptData) {
        console.log("SCRIPT DATA NULL");
        return null;
    }
    if (!scriptData.processed.analyzed) {
        console.log("SCRIPT NOT ANALYZED");
        return null;
    }
    const reader = scriptData.processed.analyzed.read();
    const tableId = dashql.ContextObjectID.getObject(table);
    if (tableId >= reader.tablesLength()) {
        console.log("TABLE ID OUT OF BOUNDS");
        return null;
    }
    const tableProto = reader.tables(tableId);
    return tableProto;
}
