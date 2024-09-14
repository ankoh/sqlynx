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
    tableReference: sqlynx.ExternalObjectID.Value;
}

export interface FocusedCompletion {
    /// The completion
    completion: sqlynx.proto.CompletionT;
    /// The index of the selected completion candidate
    completionCandidateIndex: number;
}

export const FOCUSED_TABLE_REF_ID = Symbol('FOCUSED_TABLE_REF_ID');
export const FOCUSED_EXPRESSION_ID = Symbol('FOCUSED_EXPRESSION_ID');
export const FOCUSED_COMPLETION = Symbol('FOCUSED_COMPLETION');

export type FocusTarget =
    QualifiedCatalogObjectID
    | VariantKind<typeof FOCUSED_TABLE_REF_ID, FocusedTableRef>
    | VariantKind<typeof FOCUSED_EXPRESSION_ID, FocusedExpression>
    | VariantKind<typeof FOCUSED_COMPLETION, FocusedCompletion>
    ;

export enum FocusType {
    COMPLETION_CANDIDATE_SELECTED,
    COMPLETION_CANDIDATE_SELECTED_PATH,
    COMPLETION_CANDIDATE_ALTERNATIVE,
    COMPLETION_CANDIDATE_ALTERNATIVE_PATH,
    TARGET_IN_CATALOG,
    TARGET_PATH_IN_CATALOG,
    TARGET_TABLE_REF,
    TARGET_COLUMN_REF,
    COLUMN_REF_OF_TARGET_TABLE,
    COLUMN_REF_OF_TARGET_COLUMN,
    COLUMN_REF_OF_PEER_COLUMN,
    TABLE_REF_OF_TARGET_TABLE,
    TABLE_REF_OF_TARGET_COLUMN,
}

export interface DerivedFocus {
    /// The input focus target
    focusTarget: FocusTarget;

    /// The databases
    catalogDatabases: Map<number, FocusType>;
    /// The schemas
    catalogSchemas: Map<number, FocusType>;
    /// The tables
    catalogTables: Map<sqlynx.ExternalObjectID.Value, FocusType>;
    /// The table columns
    catalogColumns: Map<sqlynx.ExternalObjectChildID.Value, FocusType>;

    /// The column references
    scriptColumnRefs: Map<sqlynx.ExternalObjectID.Value, FocusType>;
    /// The table references
    scriptTableRefs: Map<sqlynx.ExternalObjectID.Value, FocusType>;
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
                    tableReference: sqlynx.ExternalObjectID.create(scriptKey, context.tableReferenceId)
                }
            };
            const focus: DerivedFocus = {
                focusTarget,
                catalogDatabases: new Map(),
                catalogSchemas: new Map(),
                catalogTables: new Map(),
                catalogColumns: new Map(),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.tableReferences(context.tableReferenceId)!;
            if (sourceRef.innerType() == sqlynx.proto.TableReferenceSubType.ResolvedRelationExpression) {
                const resolved = sourceRef.inner(tmpResolvedRelationExpr) as sqlynx.proto.ResolvedRelationExpression;

                // Focus in catalog
                focus.catalogDatabases.set(resolved.catalogDatabaseId(), FocusType.TARGET_PATH_IN_CATALOG);
                focus.catalogSchemas.set(resolved.catalogSchemaId(), FocusType.TARGET_PATH_IN_CATALOG);
                focus.catalogTables.set(resolved.catalogTableId(), FocusType.TARGET_IN_CATALOG);

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
                            focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(targetKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(targetKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
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
                catalogDatabases: new Map(),
                catalogSchemas: new Map(),
                catalogTables: new Map(),
                catalogColumns: new Map(),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.expressions(context.expressionId)!;
            if (sourceRef.innerType() == sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression) {
                const resolved = sourceRef.inner(tmpResolvedColumnRef) as sqlynx.proto.ResolvedColumnRefExpression;

                // Focus in catalog
                focus.catalogDatabases.set(resolved.catalogDatabaseId(), FocusType.TARGET_PATH_IN_CATALOG);
                focus.catalogSchemas.set(resolved.catalogSchemaId(), FocusType.TARGET_PATH_IN_CATALOG);
                focus.catalogTables.set(resolved.catalogTableId(), FocusType.TARGET_IN_CATALOG);
                focus.catalogColumns.set(resolved.catalogTableId(), FocusType.TARGET_IN_CATALOG);

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
                            focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(targetKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_COLUMN);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(targetKey, columnRefId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(targetKey, columnRefId), FocusType.COLUMN_REF_OF_TARGET_COLUMN);
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
            return {
                focusTarget: target,
                catalogDatabases: new Map([
                    [target.value.database, FocusType.TARGET_IN_CATALOG],
                ]),
                catalogSchemas: new Map(),
                catalogTables: new Map(),
                catalogColumns: new Map(),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
        case QUALIFIED_SCHEMA_ID:
            return {
                focusTarget: target,
                catalogDatabases: new Map([
                    [target.value.database, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogSchemas: new Map([
                    [target.value.schema, FocusType.TARGET_IN_CATALOG],
                ]),
                catalogTables: new Map(),
                catalogColumns: new Map(),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
        case QUALIFIED_TABLE_ID: {
            const focus: DerivedFocus = {
                focusTarget: target,
                catalogDatabases: new Map([
                    [target.value.database, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogSchemas: new Map([
                    [target.value.schema, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogTables: new Map([
                    [target.value.table, FocusType.TARGET_IN_CATALOG],
                ]),
                catalogColumns: new Map(),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
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
                    focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(targetKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
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
                    focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(targetKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
                }
            }
            return focus;
        }
        case QUALIFIED_TABLE_COLUMN_ID: {
            const focus: DerivedFocus = {
                focusTarget: target,
                catalogDatabases: new Map([
                    [target.value.database, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogSchemas: new Map([
                    [target.value.schema, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogTables: new Map([
                    [target.value.table, FocusType.TARGET_PATH_IN_CATALOG],
                ]),
                catalogColumns: new Map([
                    [sqlynx.ExternalObjectChildID.create(target.value.table, target.value.column), FocusType.TARGET_IN_CATALOG],
                ]),
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
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
                    focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(targetKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
                }

                // Find column refs
                const [begin1, end1] = sqlynx.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                    target.value.column
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const expressionId = indexEntry.expressionId();
                    focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(targetKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_COLUMN);
                }
            }
            return focus;
        }

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
