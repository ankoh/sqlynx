import * as dashql from '@ankoh/dashql-core';

import { ScriptData, ScriptKey } from './notebook_scripts.js';
import { VariantKind } from '../../../utils/variant.js';
import { QUALIFIED_DATABASE_ID, QUALIFIED_SCHEMA_ID, QUALIFIED_TABLE_COLUMN_ID, QUALIFIED_TABLE_ID, QualifiedCatalogObjectID } from './catalog_object_id.js';

export interface FocusedExpression {
    /// The expression id
    expression: dashql.ExternalObjectID.Value;
}
export interface FocusedTableRef {
    /// The table ref
    tableReference: dashql.ExternalObjectID.Value;
}

export interface FocusedCompletion {
    /// The completion
    completion: dashql.FlatBufferPtr<dashql.buffers.completion.Completion>;
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

export interface SemanticUserFocus {
    /// The input focus target
    focusTarget: FocusTarget;
    /// The focused catalog object
    catalogObject: (QualifiedCatalogObjectID & { focus: FocusType }) | null;
    /// The column references in the script, referencing the catalog object
    scriptColumnRefs: Map<dashql.ExternalObjectID.Value, FocusType>;
    /// The table references in the script, referencing the catalog object
    scriptTableRefs: Map<dashql.ExternalObjectID.Value, FocusType>;
}

export function deriveFocusFromEditorUpdate(
    scriptKey: ScriptKey,
    update: dashql.buffers.editor.EditorUpdateT | null | undefined,
): SemanticUserFocus | null {
    const context = update?.primaryCursorContext;
    if (context == null || context.kind === dashql.buffers.editor.EditorCursorSemanticKind.NONE) {
        return null;
    }
    const isTable = context.kind === dashql.buffers.editor.EditorCursorSemanticKind.TABLE_REFERENCE;
    const focusTarget: FocusTarget = isTable
        ? {
            type: FOCUSED_TABLE_REF_ID,
            value: { tableReference: dashql.ExternalObjectID.create(scriptKey, context.referenceId) },
        }
        : {
            type: FOCUSED_EXPRESSION_ID,
            value: { expression: dashql.ExternalObjectID.create(scriptKey, context.referenceId) },
        };
    const focus: SemanticUserFocus = {
        focusTarget,
        catalogObject: null,
        scriptTableRefs: new Map(),
        scriptColumnRefs: new Map(),
    };
    if (context.resolved) {
        focus.catalogObject = context.kind === dashql.buffers.editor.EditorCursorSemanticKind.COLUMN_REFERENCE
            ? {
                type: QUALIFIED_TABLE_COLUMN_ID,
                value: {
                    database: context.catalogDatabaseId,
                    schema: context.catalogSchemaId,
                    table: context.catalogTableId,
                    column: context.catalogColumnId,
                    referencedCatalogVersion: context.referencedCatalogVersion,
                },
                focus: FocusType.COLUMN_REF,
            }
            : {
                type: QUALIFIED_TABLE_ID,
                value: {
                    database: context.catalogDatabaseId,
                    schema: context.catalogSchemaId,
                    table: context.catalogTableId,
                    referencedCatalogVersion: context.referencedCatalogVersion,
                },
                focus: FocusType.TABLE_REF,
            };
    }
    for (const referenceId of context.relatedTableReferenceIds) {
        focus.scriptTableRefs.set(
            dashql.ExternalObjectID.create(scriptKey, referenceId),
            isTable && referenceId === context.referenceId
                ? FocusType.TABLE_REF_UNDER_CURSOR
                : isTable ? FocusType.TABLE_REF_OF_TARGET_TABLE : FocusType.TABLE_REF_OF_TARGET_COLUMN,
        );
    }
    for (const referenceId of context.relatedColumnReferenceIds) {
        let focusType = isTable ? FocusType.COLUMN_REF_OF_TARGET_TABLE : FocusType.COLUMN_REF_OF_TARGET_TABLE;
        if (!isTable && referenceId === context.referenceId) focusType = FocusType.COLUMN_REF_UNDER_CURSOR;
        focus.scriptColumnRefs.set(dashql.ExternalObjectID.create(scriptKey, referenceId), focusType);
    }
    return focus;
}

/// Derive focus from script completion
export function deriveFocusFromCompletionCandidates(
    _scriptKey: ScriptKey,
    scriptData: ScriptData,
): SemanticUserFocus | null {
    if (scriptData.completion == null) {
        return null;
    }
    const completion = scriptData.completion.buffer.read();
    if (completion.candidates.length == 0 || scriptData.completion.candidateId >= completion.candidates.length) {
        return null;
    }

    const focusedCandidateId = scriptData.completion.candidateId ?? 0;
    const focusTarget: FocusTarget = {
        type: FOCUSED_COMPLETION,
        value: {
            completion: scriptData.completion.buffer,
            completionCandidateIndex: focusedCandidateId
        }
    };
    const focus: SemanticUserFocus = {
        focusTarget,
        catalogObject: null,
        scriptTableRefs: new Map(),
        scriptColumnRefs: new Map(),
    };

    // Are we focusing a valid catalog object?
    const candidate = completion.candidates(focusedCandidateId)!;
    if (scriptData.completion.catalogObjectId >= candidate.catalogObjectsLength()) {
        return focus;
    }
    const candidateObject = candidate.catalogObjects(scriptData.completion.catalogObjectId)!;

    // Inspect the catalog object and derive a focus target
    switch (candidateObject.objectType()) {
        case dashql.buffers.completion.CompletionCandidateObjectType.DATABASE:
            focus.catalogObject = {
                type: QUALIFIED_DATABASE_ID,
                value: {
                    database: candidateObject.catalogDatabaseId()
                },
                focus: FocusType.COMPLETION_CANDIDATE
            };
            break;
        case dashql.buffers.completion.CompletionCandidateObjectType.SCHEMA:
            focus.catalogObject = {
                type: QUALIFIED_SCHEMA_ID,
                value: {
                    database: candidateObject.catalogDatabaseId(),
                    schema: candidateObject.catalogSchemaId()
                },
                focus: FocusType.COMPLETION_CANDIDATE
            };
            break;
        case dashql.buffers.completion.CompletionCandidateObjectType.TABLE:
            focus.catalogObject = {
                type: QUALIFIED_TABLE_ID,
                value: {
                    database: candidateObject.catalogDatabaseId(),
                    schema: candidateObject.catalogSchemaId(),
                    table: candidateObject.catalogTableId(),
                    referencedCatalogVersion: candidateObject.referencedCatalogVersion(),
                },
                focus: FocusType.COMPLETION_CANDIDATE
            };
            break;
        case dashql.buffers.completion.CompletionCandidateObjectType.COLUMN:
            focus.catalogObject = {
                type: QUALIFIED_TABLE_COLUMN_ID,
                value: {
                    database: candidateObject.catalogDatabaseId(),
                    schema: candidateObject.catalogSchemaId(),
                    table: candidateObject.catalogTableId(),
                    column: candidateObject.tableColumnId(),
                    referencedCatalogVersion: candidateObject.referencedCatalogVersion(),
                },
                focus: FocusType.COMPLETION_CANDIDATE
            };
            break;
        case dashql.buffers.completion.CompletionCandidateObjectType.FUNCTION:
            break;
    }
    return focus;
}
