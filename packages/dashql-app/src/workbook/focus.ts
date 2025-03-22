import * as dashql from '@ankoh/dashql-core';

import { ScriptData, ScriptKey } from './workbook_state.js';
import { VariantKind } from '../utils/variant.js';
import { QUALIFIED_DATABASE_ID, QUALIFIED_SCHEMA_ID, QUALIFIED_TABLE_COLUMN_ID, QUALIFIED_TABLE_ID, QualifiedCatalogObjectID } from './catalog_object_id.js';

export interface FocusedExpression {
    /// The expression id
    expression: dashql.ContextObjectID.Value;
}
export interface FocusedTableRef {
    /// The table ref
    tableReference: dashql.ContextObjectID.Value;
}

export interface FocusedCompletion {
    /// The completion
    completion: dashql.buffers.CompletionT;
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
    COLUMN_REF_UNDER_CURSOR,
    COLUMN_REF_OF_TARGET_TABLE,
    COLUMN_REF_OF_TARGET_COLUMN,
    COLUMN_REF_OF_PEER_COLUMN,
    TABLE_REF,
    TABLE_REF_UNDER_CURSOR,
    TABLE_REF_OF_TARGET_TABLE,
    TABLE_REF_OF_TARGET_COLUMN,
}

export interface UserFocus {
    /// The input focus target
    focusTarget: FocusTarget;

    /// The focused catalog objects
    catalogObjects: (QualifiedCatalogObjectID & { focus: FocusType })[];
    /// The column references
    scriptColumnRefs: Map<dashql.ContextObjectID.Value, FocusType>;
    /// The table references
    scriptTableRefs: Map<dashql.ContextObjectID.Value, FocusType>;
}

/// Derive focus from script cursor
export function deriveFocusFromScriptCursor(
    scriptKey: ScriptKey,
    scriptData: ScriptData,
    cursor: dashql.buffers.ScriptCursorT,
): UserFocus | null {
    const tmpSourceAnalyzed = new dashql.buffers.AnalyzedScript();
    const tmpTargetAnalyzed = new dashql.buffers.AnalyzedScript();
    const tmpIndexedTableRef = new dashql.buffers.IndexedTableReference();
    const tmpIndexedColumnRef = new dashql.buffers.IndexedColumnReference();
    const tmpResolvedColumnRef = new dashql.buffers.ResolvedColumnRefExpression();
    const tmpResolvedRelationExpr = new dashql.buffers.ResolvedRelationExpression();

    let sourceAnalyzed = scriptData.processed.analyzed?.read(tmpSourceAnalyzed);
    if (sourceAnalyzed == null) {
        return null;
    }

    switch (cursor.contextType) {
        case dashql.buffers.ScriptCursorContext.ScriptCursorTableRefContext: {
            const context = cursor.context as dashql.buffers.ScriptCursorTableRefContextT;
            const focusTarget: FocusTarget = {
                type: FOCUSED_TABLE_REF_ID,
                value: {
                    tableReference: dashql.ContextObjectID.create(scriptKey, context.tableReferenceId)
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
            if (sourceRef.innerType() == dashql.buffers.TableReferenceSubType.ResolvedRelationExpression) {
                const resolved = sourceRef.inner(tmpResolvedRelationExpr) as dashql.buffers.ResolvedRelationExpression;

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
                if (!dashql.ContextObjectID.isNull(resolved.catalogTableId())) {
                    // Read the analyzed script
                    const targetAnalyzed = scriptData.processed.analyzed?.read(tmpTargetAnalyzed);
                    if (targetAnalyzed != null) {
                        // Find table refs for table
                        const [begin0, end0] = dashql.findScriptTableRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId()
                        );
                        for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                            const tableRefId = indexEntry.tableReferenceId();
                            const focusType = (tableRefId == context.tableReferenceId) ? FocusType.TABLE_REF_UNDER_CURSOR : FocusType.TABLE_REF_OF_TARGET_TABLE;
                            focus.scriptTableRefs.set(dashql.ContextObjectID.create(scriptKey, tableRefId), focusType);
                        }
                        // Find column refs for table
                        const [begin1, end1] = dashql.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId()
                        );
                        for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const expressionId = indexEntry.expressionId();
                            const focusType = FocusType.COLUMN_REF_OF_TARGET_TABLE;
                            focus.scriptColumnRefs.set(dashql.ContextObjectID.create(scriptKey, expressionId), focusType);
                        }
                    }
                }
            }
            return focus;
        }
        case dashql.buffers.ScriptCursorContext.ScriptCursorColumnRefContext: {
            const context = cursor.context as dashql.buffers.ScriptCursorColumnRefContextT;
            const focusTarget: FocusTarget = {
                type: FOCUSED_EXPRESSION_ID,
                value: {
                    expression: dashql.ContextObjectID.create(scriptKey, context.expressionId)
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
            if (sourceRef.innerType() == dashql.buffers.ExpressionSubType.ResolvedColumnRefExpression) {
                const resolved = sourceRef.inner(tmpResolvedColumnRef) as dashql.buffers.ResolvedColumnRefExpression;

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
                if (!dashql.ContextObjectID.isNull(resolved.catalogTableId())) {
                    // Read the analyzed script
                    const targetAnalyzed = scriptData.processed.analyzed?.read(tmpTargetAnalyzed);
                    if (targetAnalyzed != null) {
                        // Find table refs for table
                        const [begin0, end0] = dashql.findScriptTableRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                        );
                        for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                            const tableRefId = indexEntry.tableReferenceId();
                            focus.scriptTableRefs.set(dashql.ContextObjectID.create(scriptKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_COLUMN);
                        }
                        // Find column refs for table
                        const [begin1, end1] = dashql.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                        );
                        for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const columnRefId = indexEntry.expressionId();
                            focus.scriptColumnRefs.set(dashql.ContextObjectID.create(scriptKey, columnRefId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
                        }
                        // Find column refs for table
                        const [begin2, end2] = dashql.findScriptColumnRefsEqualRange(
                            targetAnalyzed,
                            resolved.catalogDatabaseId(),
                            resolved.catalogSchemaId(),
                            resolved.catalogTableId(),
                            resolved.columnId(),
                        );
                        for (let indexEntryId = begin2; indexEntryId < end2; ++indexEntryId) {
                            const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                            const columnRefId = indexEntry.expressionId();
                            const focusType = (columnRefId == context.expressionId) ? FocusType.COLUMN_REF_UNDER_CURSOR : FocusType.COLUMN_REF_OF_TARGET_COLUMN;
                            focus.scriptColumnRefs.set(dashql.ContextObjectID.create(scriptKey, columnRefId), focusType);
                        }
                    }
                }
            }
            return focus;
        }

        case dashql.buffers.ScriptCursorContext.NONE:
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
    const tmpAnalyzed = new dashql.buffers.AnalyzedScript();
    const tmpIndexedTableRef = new dashql.buffers.IndexedTableReference();
    const tmpIndexedColumnRef = new dashql.buffers.IndexedColumnReference();

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
            for (const k in scriptData) {
                // Is there data for the script key?
                const d = scriptData[k];
                if (!d) {
                    continue;
                }
                // Read the analyzed script
                const targetAnalyzed = scriptData[k].processed.analyzed?.read(tmpAnalyzed);
                if (!targetAnalyzed) continue;

                // Find table refs
                const [begin0, end0] = dashql.findScriptTableRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                );
                for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                    const tableRefId = indexEntry.tableReferenceId();
                    focus.scriptTableRefs.set(dashql.ContextObjectID.create(d.scriptKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
                }

                // Find column refs
                const [begin1, end1] = dashql.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const expressionId = indexEntry.expressionId();
                    focus.scriptColumnRefs.set(dashql.ContextObjectID.create(d.scriptKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_TABLE);
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
            for (const k in scriptData) {
                // Is there data for the script key?
                const d = scriptData[k];
                if (!d) {
                    continue;
                }
                // Read the analyzed script
                const targetAnalyzed = scriptData[k].processed.analyzed?.read(tmpAnalyzed);
                if (!targetAnalyzed) continue;

                // Find table refs
                const [begin0, end0] = dashql.findScriptTableRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                );
                for (let indexEntryId = begin0; indexEntryId < end0; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.tableReferencesById(indexEntryId, tmpIndexedTableRef)!;
                    const tableRefId = indexEntry.tableReferenceId();
                    focus.scriptTableRefs.set(dashql.ContextObjectID.create(d.scriptKey, tableRefId), FocusType.TABLE_REF_OF_TARGET_TABLE);
                }

                // Find column refs
                const [begin1, end1] = dashql.findScriptColumnRefsEqualRange(
                    targetAnalyzed,
                    target.value.database,
                    target.value.schema,
                    target.value.table,
                    target.value.column
                );
                for (let indexEntryId = begin1; indexEntryId < end1; ++indexEntryId) {
                    const indexEntry = targetAnalyzed.columnReferencesById(indexEntryId, tmpIndexedColumnRef)!;
                    const expressionId = indexEntry.expressionId();
                    focus.scriptColumnRefs.set(dashql.ContextObjectID.create(d.scriptKey, expressionId), FocusType.COLUMN_REF_OF_TARGET_COLUMN);
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
            case dashql.buffers.CompletionCandidateObjectType.DATABASE:
                focus.catalogObjects.push({
                    type: QUALIFIED_DATABASE_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
            case dashql.buffers.CompletionCandidateObjectType.SCHEMA:
                focus.catalogObjects.push({
                    type: QUALIFIED_SCHEMA_ID,
                    value: {
                        database: candidateObject.catalogDatabaseId,
                        schema: candidateObject.catalogSchemaId
                    },
                    focus: FocusType.COMPLETION_CANDIDATE
                });
                break;
            case dashql.buffers.CompletionCandidateObjectType.TABLE:
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
            case dashql.buffers.CompletionCandidateObjectType.COLUMN:
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
