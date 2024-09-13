import * as sqlynx from '@ankoh/sqlynx-core';

import { ScriptData, ScriptKey } from './session_state.js';
import { VariantKind } from '../utils/variant.js';
import { QUALIFIED_DATABASE_ID, QUALIFIED_SCHEMA_ID, QUALIFIED_TABLE_COLUMN_ID, QUALIFIED_TABLE_ID, QualifiedCatalogObjectID } from './catalog_object_id.js';

export interface FocusedExpression {
    /// The expression id
    expression: sqlynx.ExternalObjectID.Value;
}
export interface FocusedTableRef {
    /// The table ref
    table_reference: sqlynx.ExternalObjectID.Value;
}

export const FOCUSED_TABLE_REF_ID = Symbol('FOCUSED_TABLE_REF_ID');
export const FOCUSED_EXPRESSION_ID = Symbol('FOCUSED_EXPRESSION_ID');

export type FocusTarget =
    QualifiedCatalogObjectID
    | VariantKind<typeof FOCUSED_TABLE_REF_ID, FocusedTableRef>
    | VariantKind<typeof FOCUSED_EXPRESSION_ID, FocusedExpression>
    ;

export interface DerivedFocus {
    /// The input focus target
    focusTarget: FocusTarget;

    /// The focused catalog object
    focusedCatalogObject: QualifiedCatalogObjectID | null;
    /// The column references of the focused table
    columnRefsOfFocusedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The table references of focused table
    tableRefsOfFocusedTable: Set<sqlynx.ExternalObjectID.Value>;
    /// The column references of the focused column
    columnRefsOfFocusedColumn: Set<sqlynx.ExternalObjectID.Value>;
}

/// Derive focus from script cursor
export function deriveFocusFromScriptCursor(
    scriptKey: ScriptKey,
    scriptData: {
        [context: number]: ScriptData;
    },
    cursor: sqlynx.proto.ScriptCursorT,
): DerivedFocus | null {
    const tmpSourceAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpTargetAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();
    const tmpResolvedColumnRef = new sqlynx.proto.ResolvedColumnRefExpression();
    const tmpResolvedRelationExpr = new sqlynx.proto.ResolvedRelationExpression();

    const source = scriptData[scriptKey];
    let sourceAnalyzed = source.processed.analyzed?.read(tmpSourceAnalyzed);
    if (sourceAnalyzed == null) {
        return null;
    }

    switch (cursor.contextType) {
        case sqlynx.proto.ScriptCursorContext.ScriptCursorTableRefContext: {
            const context = cursor.context as sqlynx.proto.ScriptCursorTableRefContextT;
            const focusTarget: FocusTarget = {
                type: FOCUSED_TABLE_REF_ID,
                value: {
                    table_reference: sqlynx.ExternalObjectID.create(scriptKey, context.tableReferenceId)
                }
            };
            const focus: DerivedFocus = {
                focusTarget,
                focusedCatalogObject: null,
                columnRefsOfFocusedTable: new Set(),
                tableRefsOfFocusedTable: new Set(),
                columnRefsOfFocusedColumn: new Set(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.tableReferences(context.tableReferenceId)!;
            if (sourceRef.innerType() == sqlynx.proto.TableReferenceSubType.ResolvedRelationExpression) {
                const resolved = sourceRef.inner(tmpResolvedRelationExpr) as sqlynx.proto.ResolvedRelationExpression;
                focus.focusedCatalogObject = {
                    type: QUALIFIED_TABLE_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                    }
                };

                // Could we resolve the ref?
                if (!sqlynx.ExternalObjectID.isNull(resolved.catalogTableId())) {
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
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId()
                        );
                        for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                            const tableRefId = indexEntry.tableReferenceId();
                            focus.tableRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
                        }
                        // Find column refs for table
                        const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId()
                        );
                        for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const expressionId = indexEntry.expressionId();
                            focus.columnRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, expressionId));
                        }
                    }
                }
            }
            return focus;
        }
        case sqlynx.proto.ScriptCursorContext.ScriptCursorColumnRefContext: {
            const context = cursor.context as sqlynx.proto.ScriptCursorColumnRefContextT;
            const focusTarget: FocusTarget = {
                type: FOCUSED_EXPRESSION_ID,
                value: {
                    expression: sqlynx.ExternalObjectID.create(scriptKey, context.expressionId)
                }
            };
            const focus: DerivedFocus = {
                focusTarget,
                focusedCatalogObject: null,
                columnRefsOfFocusedTable: new Set(),
                tableRefsOfFocusedTable: new Set(),
                columnRefsOfFocusedColumn: new Set(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.expressions(context.expressionId)!;
            if (sourceRef.innerType() == sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression) {
                const resolved = sourceRef.inner(tmpResolvedColumnRef) as sqlynx.proto.ResolvedColumnRefExpression;
                focus.focusedCatalogObject = {
                    type: QUALIFIED_TABLE_COLUMN_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                        column: resolved.columnId(),
                    }
                };

                // Could we resolve the ref?
                if (!sqlynx.ExternalObjectID.isNull(resolved.catalogTableId())) {
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
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                        );
                        for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                            const tableRefId = indexEntry.tableReferenceId();
                            focus.tableRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
                        }
                        // Find column refs for table
                        const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                        );
                        for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const columnRefId = indexEntry.expressionId();
                            focus.columnRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, columnRefId));
                        }
                        // Find column refs for table
                        const [begin2, end2] = sqlynx.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                            resolved.columnId(),
                        );
                        for (let indexEntryId = begin2; indexEntryId < end2; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const columnRefId = indexEntry.expressionId();
                            focus.columnRefsOfFocusedColumn.add(sqlynx.ExternalObjectID.create(targetKey, columnRefId));
                        }
                    }
                }
            }
            return focus;
        }

        case sqlynx.proto.ScriptCursorContext.NONE:
            break;
    }
    return null;
}

/// Derive focus from catalog
export function deriveFocusFromCatalogSelection(
    scriptData: {
        [context: number]: ScriptData;
    },
    target: QualifiedCatalogObjectID
): DerivedFocus | null {
    const tmpAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();

    switch (target.type) {
        case QUALIFIED_DATABASE_ID:
        case QUALIFIED_SCHEMA_ID:
            return {
                focusTarget: target,
                focusedCatalogObject: target,
                columnRefsOfFocusedTable: new Set(),
                tableRefsOfFocusedTable: new Set(),
                columnRefsOfFocusedColumn: new Set(),
            };
        case QUALIFIED_TABLE_ID: {
            const focus: DerivedFocus = {
                focusTarget: target,
                focusedCatalogObject: target,
                columnRefsOfFocusedTable: new Set(),
                tableRefsOfFocusedTable: new Set(),
                columnRefsOfFocusedColumn: new Set(),
            };
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
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                );
                for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                    const tableRefId = indexEntry.tableReferenceId();
                    focus.tableRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, tableRefId));
                }

                // Find column refs
                const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const expressionId = indexEntry.expressionId();
                    focus.columnRefsOfFocusedTable.add(sqlynx.ExternalObjectID.create(targetKey, expressionId));
                }
            }
            return focus;
        }
        case QUALIFIED_TABLE_COLUMN_ID:
            // XXX Focus on peer columns?
            return {
                focusTarget: target,
                focusedCatalogObject: target,
                columnRefsOfFocusedTable: new Set(),
                tableRefsOfFocusedTable: new Set(),
                columnRefsOfFocusedColumn: new Set(),
            };

    }
}

/// Derive focus from script completion
export function deriveFocusFromCompletionCandidates(
    scriptKey: ScriptKey,
    scriptData: {
        [context: number]: ScriptData;
    }
) {
    const data = scriptData[scriptKey];
    if (data.completion == null) {
        return;
    }
    console.log(data.completion.candidates);
}
