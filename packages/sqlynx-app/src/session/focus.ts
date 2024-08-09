import * as sqlynx from '@ankoh/sqlynx-core';
import { SessionState, ScriptData, ScriptKey } from './session_state.js';

export interface DerivedFocus {
    /// The focused table
    focusedTable: sqlynx.QualifiedTableID | null;
    /// The focused column references
    focusedColumnRef: sqlynx.ExternalObjectID.Value | null;
    /// The focused table references
    focusedTableRef: sqlynx.ExternalObjectID.Value | null;

    /// The referenced table
    referencedTable: sqlynx.QualifiedTableID | null;
    /// The referenced column id
    referencedColumnId: number | null;

    /// The column references of the focused table
    columnRefsOfReferencedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The table references of focused table
    tableRefsOfReferencedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The column references of the focused column
    columnRefsOfReferencedColumn: Set<sqlynx.ExternalObjectID.Value>;
}

/// Derive focus from script cursors
export function deriveScriptFocusFromCursor(
    scriptKey: ScriptKey,
    scriptData: {
        [context: number]: ScriptData;
    },
    cursor: sqlynx.proto.ScriptCursorInfoT,
): DerivedFocus {
    const tmpAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();

    // The result focus
    const focus: DerivedFocus = {
        focusedTable: null,
        focusedColumnRef: null,
        focusedTableRef: null,
        referencedTable: null,
        referencedColumnId: null,
        columnRefsOfReferencedTable: new Set(),
        tableRefsOfReferencedTable: new Set(),
        columnRefsOfReferencedColumn: new Set(),
    };

    // Script is not analyzed?
    const sourceData = scriptData[scriptKey];
    if (!sourceData || sourceData.processed.analyzed === null) {
        return focus;
    }
    const sourceAnalyzed = sourceData.processed.analyzed?.read(tmpAnalyzed);

    // User focused on a table reference?
    const tableRefId = sqlynx.ExternalObjectID.create(scriptKey, cursor.tableReferenceId);
    if (!sqlynx.ExternalObjectID.isNull(tableRefId)) {
        // Is focused table reference?
        focus.focusedTableRef = tableRefId;
        // Get referenced table
        const sourceRef = sourceAnalyzed.tableReferences(cursor.tableReferenceId)!;
        focus.referencedTable = {
            databaseId: sourceRef.resolvedCatalogDatabaseId(),
            schemaId: sourceRef.resolvedCatalogSchemaId(),
            tableId: sourceRef.resolvedCatalogTableId(),
        };

        // Cout we resolve the ref?
        if (!sqlynx.ExternalObjectID.isNull(focus.referencedTable.tableId)) {
            const tmpTargetAnalyzed = new sqlynx.proto.AnalyzedScript();
            // Check the main and schema script for associated table and column refs
            for (const targetKey of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                // Is there data for the script key?
                const targetData = scriptData[targetKey];
                if (!targetData) {
                    continue;
                }
                // Read the analyzed script
                const targetAnalyzed = scriptData[targetKey].processed.analyzed?.read(tmpTargetAnalyzed);
                if (!targetAnalyzed) continue;

                // Find table refs for table
                const [begin0, end0] = sqlynx.tableRefsEqualRange(
                    targetAnalyzed,
                    tmpIndexedTableRef,
                    0,
                    targetAnalyzed.tableReferencesLength(),
                    focus.referencedTable.databaseId,
                    focus.referencedTable.schemaId,
                    focus.referencedTable.tableId
                );
                for (let refId = begin0; refId < end0; ++refId) {
                    focus.tableRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, refId));
                }
                // Find column refs for table
                const [begin1, end1] = sqlynx.columnRefsEqualRangeByTable(
                    targetAnalyzed,
                    tmpIndexedColumnRef,
                    0,
                    targetAnalyzed.columnReferencesLength(),
                    focus.referencedTable.databaseId,
                    focus.referencedTable.schemaId,
                    focus.referencedTable.tableId
                );
                for (let refId = begin1; refId < end1; ++refId) {
                    focus.columnRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, refId));
                }
            }
        }
        return focus;
    }

    // User focused on a column reference?
    const columnRefId = sqlynx.ExternalObjectID.create(scriptKey, cursor.columnReferenceId);
    if (!sqlynx.ExternalObjectID.isNull(columnRefId)) {
        // Is focused table reference?
        focus.focusedColumnRef = columnRefId;
        // Get the table ref
        const sourceRef = sourceAnalyzed.columnReferences(cursor.columnReferenceId)!;
        focus.referencedTable = {
            databaseId: sourceRef.resolvedCatalogDatabaseId(),
            schemaId: sourceRef.resolvedCatalogSchemaId(),
            tableId: sourceRef.resolvedCatalogTableId(),
        };
        focus.referencedColumnId = sourceRef.resolvedColumnId();

        // Cout we resolve the ref?
        if (!sqlynx.ExternalObjectID.isNull(focus.referencedTable.tableId)) {
            const tmpTargetAnalyzed = new sqlynx.proto.AnalyzedScript();
            // Check the main and schema script for associated table and column refs
            for (const targetKey of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                // Is there data for the script key?
                const targetData = scriptData[targetKey];
                if (!targetData) {
                    continue;
                }
                // Read the analyzed script
                const targetAnalyzed = scriptData[targetKey].processed.analyzed?.read(tmpTargetAnalyzed);
                if (!targetAnalyzed) continue;

                // Find table refs for table
                const [begin0, end0] = sqlynx.tableRefsEqualRange(
                    targetAnalyzed,
                    tmpIndexedTableRef,
                    0,
                    targetAnalyzed.tableReferencesLength(),
                    focus.referencedTable.databaseId,
                    focus.referencedTable.schemaId,
                    focus.referencedTable.tableId
                );
                for (let refId = begin0; refId < end0; ++refId) {
                    focus.tableRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, refId));
                }
                // Find column refs for table
                const [begin1, end1] = sqlynx.columnRefsEqualRangeByTable(
                    targetAnalyzed,
                    tmpIndexedColumnRef,
                    0,
                    targetAnalyzed.columnReferencesLength(),
                    focus.referencedTable.databaseId,
                    focus.referencedTable.schemaId,
                    focus.referencedTable.tableId
                );
                for (let refId = begin1; refId < end1; ++refId) {
                    focus.columnRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, refId));
                }
                // Find column refs for table
                const [begin2, end2] = sqlynx.columnRefsEqualRange(
                    targetAnalyzed,
                    tmpIndexedColumnRef,
                    0,
                    targetAnalyzed.columnReferencesLength(),
                    focus.referencedTable.databaseId,
                    focus.referencedTable.schemaId,
                    focus.referencedTable.tableId,
                    focus.referencedColumnId
                );
                for (let refId = begin2; refId < end2; ++refId) {
                    focus.columnRefsOfReferencedColumn.add(sqlynx.ExternalObjectID.create(targetKey, refId));
                }
            }
        }
        return focus;
    }

    return focus;
}

function clearCursors(state: SessionState): SessionState {
    if (state.scripts[ScriptKey.MAIN_SCRIPT]) {
        state.scripts[ScriptKey.MAIN_SCRIPT] = {
            ...state.scripts[ScriptKey.MAIN_SCRIPT],
            cursor: null,
        };
    }
    if (state.scripts[ScriptKey.SCHEMA_SCRIPT]) {
        state.scripts[ScriptKey.SCHEMA_SCRIPT] = {
            ...state.scripts[ScriptKey.SCHEMA_SCRIPT],
            cursor: null,
        };
    }
    return state;
}

// export function focusGraphNode(state: SessionState, target: GraphNodeDescriptor | null): SessionState {
//     // Unset focused node?
//     if (target === null) {
//         // State already has cleared focus?
//         if (state.userFocus === null) {
//             return state;
//         }
//         // Otherwise clear the focus state
//         return clearCursors({
//             ...state,
//             userFocus: null,
//         });
//     }
//     // Determine the focused connections
//     const newConnections = new Set<GraphConnectionId.Value>();
//     const prevConnections = state.userFocus?.graphConnections ?? new Set();
//     let allInPrev = true;
//
//     if (target.port === null) {
//         // If no port is focused, find all edges reaching that node
//         for (const edge of state.graphViewModel.edges.values()) {
//             if (edge.fromNode == target.nodeId || edge.toNode == target.nodeId) {
//                 newConnections.add(edge.connectionId);
//                 allInPrev &&= prevConnections.has(edge.connectionId);
//             }
//         }
//     } else {
//         // If a port is focused, find all edges reaching that port
//         for (const edge of state.graphViewModel.edges.values()) {
//             if (
//                 (edge.fromNode == target.nodeId && edge.fromPort == target.port) ||
//                 (edge.toNode == target.nodeId && edge.toPort == target.port)
//             ) {
//                 newConnections.add(edge.connectionId);
//                 allInPrev &&= prevConnections.has(edge.connectionId);
//             }
//         }
//     }
//
//     // Same focus?
//     if (allInPrev && newConnections.size == prevConnections.size) {
//         return state;
//     }
//
//     // Find all column and query_result refs that are referencing that query_result
//     const tableIds: Set<sqlynx.ExternalObjectID.Value> = new Set();
//     const columnRefs: Set<sqlynx.ExternalObjectID.Value> = new Set();
//     const tableRefs: Set<sqlynx.ExternalObjectID.Value> = new Set();
//     const targetTableId = state.graphViewModel.nodes[target.nodeId].tableId;
//     if (!sqlynx.ExternalObjectID.isNull(targetTableId)) {
//         tableIds.add(targetTableId);
//         const tmpAnalyzed = new sqlynx.proto.AnalyzedScript();
//         const tmpColRef = new sqlynx.proto.ColumnReference();
//         const tmpTblRef = new sqlynx.proto.TableReference();
//         for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
//             const analyzed = state.scripts[key].processed.analyzed?.read(tmpAnalyzed);
//             if (!analyzed) continue;
//             for (let refId = 0; refId < analyzed.columnReferencesLength(); ++refId) {
//                 const colRef = analyzed.columnReferences(refId, tmpColRef)!;
//                 if (colRef.resolvedCatalogTableId() == targetTableId) {
//                     columnRefs.add(sqlynx.ExternalObjectID.create(key, refId));
//                 }
//             }
//             for (let refId = 0; refId < analyzed.tableReferencesLength(); ++refId) {
//                 const tblRef = analyzed.tableReferences(refId, tmpTblRef)!;
//                 if (tblRef.resolvedCatalogTableId() == targetTableId) {
//                     tableRefs.add(sqlynx.ExternalObjectID.create(key, refId));
//                 }
//             }
//         }
//     }
// 
// // Clear cursor and update focus
//     return state;
// }

// export function focusGraphEdge(state: SessionState, conn: GraphConnectionId.Value | null): SessionState {
//     // Unset focused edge?
//     if (conn === null) {
//         // State already has cleared focus?
//         if (state.userFocus === null) {
//             return state;
//         }
//         // Otherwise clear the focus state
//         return clearCursors({
//             ...state,
//             userFocus: null,
//         });
//     }
//     //     // Does the set of focused edges only contain the newly focused edge?
//     //     if (state.userFocus?.graphConnections?.size == 1) {
//     //         if (state.userFocus.graphConnections.has(conn)) {
//     //             return state;
//     //         }
//     //     }
//     // Get the nodes
//     const edgeVM = state.graphViewModel.edges.get(conn);
//     if (!edgeVM) {
//         console.warn(`unknown graph edge with id: ${conn}`);
//         return state;
//     }
//     // Clear cursor and update focus
//     return clearCursors({
//         ...state,
//         userFocus: {
//             graphConnections: new Set([conn]),
//             tableIds: new Set(),
//             columnRefs: edgeVM.columnRefs,
//             tableRefs: new Set(),
//         },
//     });
// }
