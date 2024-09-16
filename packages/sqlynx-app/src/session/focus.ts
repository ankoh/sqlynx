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
    COMPLETION_CANDIDATE,
    CATALOG_ENTRY,
    COLUMN_REF,
    COLUMN_REF_OF_TARGET_TABLE,
    COLUMN_REF_OF_TARGET_COLUMN,
    COLUMN_REF_OF_PEER_COLUMN,
    TABLE_REF,
    TABLE_REF_OF_TARGET_TABLE,
    TABLE_REF_OF_TARGET_COLUMN,
}

export interface UserFocus {
    /// The input focus target
    focusTarget: FocusTarget;

    /// The focused catalog objects
    catalogObjects: (QualifiedCatalogObjectID & { focus: FocusType })[];
    /// The column references
    scriptColumnRefs: Map<sqlynx.ExternalObjectID.Value, FocusType>;
    /// The table references
    scriptTableRefs: Map<sqlynx.ExternalObjectID.Value, FocusType>;
}

/// Derive focus from script cursor
export function deriveFocusFromScriptCursor(
    scriptKey: ScriptKey,
    scriptData: ScriptData,
    cursor: sqlynx.proto.ScriptCursorT,
): UserFocus | null {
    const tmpSourceAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpTargetAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();
    const tmpResolvedColumnRef = new sqlynx.proto.ResolvedColumnRefExpression();
    const tmpResolvedRelationExpr = new sqlynx.proto.ResolvedRelationExpression();

    let sourceAnalyzed = scriptData.processed.analyzed?.read(tmpSourceAnalyzed);
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
            const focus: UserFocus = {
                focusTarget,
                catalogObjects: [],
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.tableReferences(context.tableReferenceId)!;
            if (sourceRef.innerType() == sqlynx.proto.TableReferenceSubType.ResolvedRelationExpression) {
                const resolved = sourceRef.inner(tmpResolvedRelationExpr) as sqlynx.proto.ResolvedRelationExpression;

                // Focus in catalog
                focus.catalogObjects = [{
                    type: QUALIFIED_TABLE_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                    },
                    focus: FocusType.TABLE_REF
                }];

                // Could we resolve the ref?
                if (!sqlynx.ExternalObjectID.isNull(resolved.catalogTableId())) {
                    // Read the analyzed script
                    const targetAnalyzed = scriptData.processed.analyzed?.read(tmpTargetAnalyzed);
                    if (targetAnalyzed != null) {
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
                            focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(scriptKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(scriptKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
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
            const focus: UserFocus = {
                focusTarget,
                catalogObjects: [],
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
            // Is resolved?
            const sourceRef = sourceAnalyzed.expressions(context.expressionId)!;
            if (sourceRef.innerType() == sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression) {
                const resolved = sourceRef.inner(tmpResolvedColumnRef) as sqlynx.proto.ResolvedColumnRefExpression;

                // Focus in catalog
                focus.catalogObjects = [{
                    type: QUALIFIED_TABLE_COLUMN_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                        column: resolved.columnId(),
                    },
                    focus: FocusType.COLUMN_REF
                }];

                // Could we resolve the ref?
                if (!sqlynx.ExternalObjectID.isNull(resolved.catalogTableId())) {
                    // Read the analyzed script
                    const targetAnalyzed = scriptData.processed.analyzed?.read(tmpTargetAnalyzed);
                    if (targetAnalyzed != null) {
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
                            focus.scriptTableRefs.set(sqlynx.ExternalObjectID.create(scriptKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_COLUMN);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(scriptKey, columnRefId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
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
                            focus.scriptColumnRefs.set(sqlynx.ExternalObjectID.create(scriptKey, columnRefId), FocusType.COLUMN_REF_OF_TARGET_COLUMN);
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
): UserFocus | null {
    const tmpAnalyzed = new sqlynx.proto.AnalyzedScript();
    const tmpIndexedTableRef = new sqlynx.proto.IndexedTableReference();
    const tmpIndexedColumnRef = new sqlynx.proto.IndexedColumnReference();

    switch (target.type) {
        case QUALIFIED_DATABASE_ID:
        case QUALIFIED_SCHEMA_ID:
            return {
                focusTarget: target,
                catalogObjects: [{
                    ...target,
                    focus: FocusType.CATALOG_ENTRY
                }],
                scriptTableRefs: new Map(),
                scriptColumnRefs: new Map(),
            };
        case QUALIFIED_TABLE_ID: {
            const focus: UserFocus = {
                focusTarget: target,
                catalogObjects: [{
                    ...target,
                    focus: FocusType.CATALOG_ENTRY
                }],
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
            const focus: UserFocus = {
                focusTarget: target,
                catalogObjects: [{
                    ...target,
                    focus: FocusType.CATALOG_ENTRY
                }],
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
    _scriptKey: ScriptKey,
    scriptData: ScriptData,
): UserFocus | null {
    if (scriptData.completion == null) {
        return null;
    }
    if (scriptData.completion.candidates.length == 0 || scriptData.selectedCompletionCandidate == null) {
        return null;
    }

    const focusTarget: FocusTarget = {
        type: FOCUSED_COMPLETION,
        value: {
            completion: scriptData.completion,
            completionCandidateIndex: scriptData.selectedCompletionCandidate ?? 0
        }
    };
    const focus: UserFocus = {
        focusTarget,
        catalogObjects: [],
        scriptTableRefs: new Map(),
        scriptColumnRefs: new Map(),
    };

    // Highlight only the selected completion candidate for now
    const candidate = scriptData.completion.candidates[scriptData.selectedCompletionCandidate ?? 0];
    for (const candidateObject of candidate.catalogObjects) {
        switch (candidateObject.objectType) {
            case sqlynx.proto.CompletionCandidateObjectType.DATABASE:
                focus.catalogObjects.push({
                    type: QUALIFIED_DATABASE_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
            case sqlynx.proto.CompletionCandidateObjectType.SCHEMA:
                focus.catalogObjects.push({
                    type: QUALIFIED_SCHEMA_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId,
                        schema: candidateObject.catalogSchemaId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
            case sqlynx.proto.CompletionCandidateObjectType.TABLE:
                focus.catalogObjects.push({
                    type: QUALIFIED_TABLE_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId,
                        schema: candidateObject.catalogSchemaId,
                        table: candidateObject.catalogTableId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
            case sqlynx.proto.CompletionCandidateObjectType.COLUMN:
                focus.catalogObjects.push({
                    type: QUALIFIED_TABLE_COLUMN_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId,
                        schema: candidateObject.catalogSchemaId,
                        table: candidateObject.catalogTableId,
                        column: candidateObject.tableColumnId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
        }
    }
    return focus;
}
