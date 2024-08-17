import * as sqlynx from '@ankoh/sqlynx-core';
import { ScriptData, ScriptKey } from './session_state.js';

export interface CatalogFocus {
    /// The focused database
    focusedDatabase: number | null;
    /// The focused schema
    focusedSchema: number | null;
    /// The focused table
    focusedTable: sqlynx.ExternalObjectID.Value | null;
}

export interface DerivedFocus {
    /// The focused database
    focusedDatabase: number | null;
    /// The focused schema
    focusedSchema: number | null;
    /// The focused table
    focusedTable: sqlynx.ExternalObjectID.Value | null;
    /// The focused column references
    focusedColumnRef: sqlynx.ExternalObjectID.Value | null;
    /// The focused table references
    focusedTableRef: sqlynx.ExternalObjectID.Value | null;

    /// The resolved table.
    /// Only missing if the user explicitly focused on either the schema or the database.
    resolvedTable: null | {
        databaseId: number;
        schemaId: number;
        tableId: sqlynx.ExternalObjectID.Value;
    };
    /// The resolved column id.
    /// Specified if the user focused a column ref.
    resolvedColumnId: number | null;

    /// The column references of the focused table
    columnRefsOfReferencedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The table references of focused table
    tableRefsOfReferencedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The column references of the focused column
    columnRefsOfReferencedColumn: Set<sqlynx.ExternalObjectID.Value>;
}

/// Derive focus from script cursor
export function deriveFocusFromCursor(
    scriptKey: ScriptKey,
    scriptData: {
        [context: number]: ScriptData;
    },
    cursor: sqlynx.proto.ScriptCursorInfoT,
): DerivedFocus {
    const tmpSourceAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpTargetAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();

    // The result focus
    const focus: DerivedFocus = {
        focusedDatabase: null,
        focusedSchema: null,
        focusedTable: null,
        focusedColumnRef: null,
        focusedTableRef: null,
        resolvedTable: null,
        resolvedColumnId: null,
        columnRefsOfReferencedTable: new Set(),
        tableRefsOfReferencedTable: new Set(),
        columnRefsOfReferencedColumn: new Set(),
    };

    // Script is not analyzed?
    const sourceData = scriptData[scriptKey];
    if (!sourceData || sourceData.processed.analyzed === null) {
        return focus;
    }
    const sourceAnalyzed = sourceData.processed.analyzed?.read(tmpSourceAnalyzed);

    // User focused on a table reference?
    const tableRefId = sqlynx.ExternalObjectID.create(scriptKey, cursor.tableReferenceId);
    if (!sqlynx.ExternalObjectID.isNull(tableRefId)) {
        // Is focused table reference?
        focus.focusedTableRef = tableRefId;
        // Get referenced table
        const sourceRef = sourceAnalyzed.tableReferences(cursor.tableReferenceId)!;
        focus.resolvedTable = {
            databaseId: sourceRef.resolvedCatalogDatabaseId(),
            schemaId: sourceRef.resolvedCatalogSchemaId(),
            tableId: sourceRef.resolvedCatalogTableId(),
        };

        // Cout we resolve the ref?
        if (!sqlynx.ExternalObjectID.isNull(focus.resolvedTable.tableId)) {
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
                const [begin0, end0] = sqlynx.findScriptTableRefsEqualRange(
                    targetAnalyzed,
                    focus.resolvedTable.databaseId,
                    focus.resolvedTable.schemaId,
                    focus.resolvedTable.tableId
                );
                for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                    const tableRefId = indexEntry.tableReferenceId();
                    focus.tableRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
                }
                // Find column refs for table
                const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    focus.resolvedTable.databaseId,
                    focus.resolvedTable.schemaId,
                    focus.resolvedTable.tableId
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const columnRefId = indexEntry.columnReferenceId();
                    focus.columnRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, columnRefId));
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
        focus.resolvedTable = {
            databaseId: sourceRef.resolvedCatalogDatabaseId(),
            schemaId: sourceRef.resolvedCatalogSchemaId(),
            tableId: sourceRef.resolvedCatalogTableId(),
        };
        focus.resolvedColumnId = sourceRef.resolvedColumnId();

        // Cout we resolve the ref?
        if (!sqlynx.ExternalObjectID.isNull(focus.resolvedTable.tableId)) {
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
                const [begin0, end0] = sqlynx.findScriptTableRefsEqualRange(
                    targetAnalyzed,
                    focus.resolvedTable.databaseId,
                    focus.resolvedTable.schemaId,
                    focus.resolvedTable.tableId
                );
                for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                    const tableRefId = indexEntry.tableReferenceId();
                    focus.tableRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
                }
                // Find column refs for table
                const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    focus.resolvedTable.databaseId,
                    focus.resolvedTable.schemaId,
                    focus.resolvedTable.tableId
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const columnRefId = indexEntry.columnReferenceId();
                    focus.columnRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, columnRefId));
                }
                // Find column refs for table
                const [begin2, end2] = sqlynx.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    focus.resolvedTable.databaseId,
                    focus.resolvedTable.schemaId,
                    focus.resolvedTable.tableId,
                    focus.resolvedColumnId
                );
                for (let indexEntryId = begin2; indexEntryId < end2; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const columnRefId = indexEntry.columnReferenceId();
                    focus.columnRefsOfReferencedColumn.add(sqlynx.ExternalObjectID.create(targetKey, columnRefId));
                }
            }
        }
        return focus;
    }

    return focus;
}

/// Derive focus from catalog
export function deriveFocusFromCatalog(
    scriptData: {
        [context: number]: ScriptData;
    },
    target: CatalogFocus
): DerivedFocus {
    const tmpAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();

    // The result focus
    const focus: DerivedFocus = {
        focusedDatabase: null,
        focusedSchema: null,
        focusedTable: null,
        focusedColumnRef: null,
        focusedTableRef: null,
        resolvedTable: null,
        resolvedColumnId: null,
        columnRefsOfReferencedTable: new Set(),
        tableRefsOfReferencedTable: new Set(),
        columnRefsOfReferencedColumn: new Set(),
    };

    // No focused database?
    // There must be at least the database focused.
    // (If the user focuses a table, the database has to be specified in the focus info)
    if (target.focusedDatabase == null) {
        return focus;
    }

    // Store focused databases and the referenced table
    focus.focusedDatabase = target.focusedDatabase;
    focus.focusedSchema = target.focusedSchema;
    focus.focusedTable = target.focusedTable;
    if (target.focusedTable) {
        focus.resolvedTable = {
            databaseId: focus.focusedDatabase!,
            schemaId: focus.focusedSchema!,
            tableId: focus.focusedTable!,
        };
    }

    // Check the main and schema script for associated table and column refs
    for (const targetKey of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
        // Is there data for the script key?
        const targetData = scriptData[targetKey];
        if (!targetData) {
            continue;
        }
        // Read the analyzed script
        const targetAnalyzed = scriptData[targetKey].processed.analyzed?.read(tmpAnalyzed);
        if (!targetAnalyzed) continue;

        // Find table refs
        const [begin0, end0] = sqlynx.findScriptTableRefsEqualRange(
            targetAnalyzed,
            target.focusedDatabase,
            target.focusedSchema,
            target.focusedTable,
        );
        for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
            const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
            const tableRefId = indexEntry.tableReferenceId();
            focus.tableRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
        }

        // Find column refs
        const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
            targetAnalyzed,
            target.focusedDatabase,
            target.focusedSchema,
            target.focusedTable,
        );
        for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
            const tableRefId = indexEntry.columnReferenceId();
            focus.columnRefsOfReferencedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
        }
    }
    return focus;
}
