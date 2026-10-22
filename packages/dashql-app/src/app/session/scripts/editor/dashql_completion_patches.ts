import * as dashql from '@ankoh/dashql-core';
import { DEFAULT_DATABASE_NAME } from '../../../connections/catalog_sql_generator.js';

import { ChangeSpec, Text } from '@codemirror/state';
import { VariantKind } from '../../../../utils/index.js';
import { DashQLCompletionState } from './dashql_processor.js';

export const PATCH_INSERT_TEXT = Symbol("INSERT_TEXT");
export const PATCH_DELETE_TEXT = Symbol("REMOVE_TEXT");

export enum CompletionPatchTarget {
    Candidate = 1,
    CatalogObject = 2,
}

export type CompletionPatchVariant =
    | VariantKind<typeof PATCH_INSERT_TEXT, InsertTextPatch>
    | VariantKind<typeof PATCH_DELETE_TEXT, RemoveTextPatch>;

export type CompletionPatch = CompletionPatchVariant & {
    /// The patch target
    target: CompletionPatchTarget;
};

export enum TextAnchor {
    Right = -1,
    Left = 1,
}

interface InsertTextPatch {
    /// The location
    at: number;
    /// The completion text
    text: string;
    /// The text anchor of the hint
    textAnchor: TextAnchor;
}

interface RemoveTextPatch {
    /// Remove text at a location
    at: number;
    /// Remove `length` characters
    length: number;
}

/// Given two strings, derive the required patches to get from `have` to `want`.
/// If `have` is a proper substring of `want`, emit before/after inserts around it.
/// Otherwise, delete `have` entirely and insert `want`.
export function completionDiff(at: number, have: string, want: string, target: CompletionPatchTarget, cursor: number): CompletionPatch[] {
    const out: CompletionPatch[] = [];
    const idx = have.length > 0 ? want.indexOf(have) : -1;
    if (idx >= 0) {
        if (idx > 0) {
            out.push({
                target,
                type: PATCH_INSERT_TEXT,
                value: { at, text: want.substring(0, idx), textAnchor: TextAnchor.Right },
            });
        }
        const after = idx + have.length;
        if (after < want.length) {
            out.push({
                target,
                type: PATCH_INSERT_TEXT,
                value: { at: at + have.length, text: want.substring(after), textAnchor: TextAnchor.Left },
            });
        }
    } else {
        if (have.length > 0) {
            out.push({
                target,
                type: PATCH_DELETE_TEXT,
                value: { at, length: have.length },
            });
        }
        out.push({
            target,
            type: PATCH_INSERT_TEXT,
            value: { at: at + have.length, text: want, textAnchor: TextAnchor.Left },
        });
    }
    return out;
}

/// Helper to read a qualified name
export function unpackQualifiedObjectName(co: dashql.buffers.completion.CompletionCandidateObject): string[] {
    const out = [];
    for (let i = 0; i < co.qualifiedNameLength(); ++i) {
        const name = co.qualifiedName(i);
        out.push(name);
    }
    return out;
}

export function shouldAutoQualifyNonDefaultTable(co: dashql.buffers.completion.CompletionCandidateObject): boolean {
    if (co.objectType() !== dashql.buffers.completion.CompletionCandidateObjectType.TABLE) return false;
    if (co.qualifiedNameLength() !== 3) return false;
    return co.qualifiedName(0)?.toLowerCase() !== DEFAULT_DATABASE_NAME;
}

function copyLazily(nextState: DashQLCompletionState, prevState: DashQLCompletionState): DashQLCompletionState {
    return nextState === prevState ? { ...prevState } : nextState;
};

export enum UpdatePatchStartingFrom {
    Candidate = 0,
    CatalogObject = 1,
}

export function computePatches(prevState: DashQLCompletionState, text: Text, cursor: number = 0, updateFrom: UpdatePatchStartingFrom = UpdatePatchStartingFrom.Candidate): DashQLCompletionState {
    const buffer = prevState.buffer.read();
    let nextState = prevState;

    /// Invalid candidate id?
    const candidateId = prevState.candidateId;
    if (candidateId >= buffer.candidatesLength()) {
        return nextState;
    }
    const candidate = buffer.candidates(candidateId)!;

    // Read locations (every patch will need them)
    const targetLoc = candidate.targetLocation();
    const qualifiedLoc = candidate.targetLocationQualified();
    if (targetLoc == null || qualifiedLoc == null) {
        return nextState;
    }
    const targetFrom = targetLoc.offset();
    const originalTargetTo = targetLoc.offset() + targetLoc.length();
    const originalQualifiedTo = qualifiedLoc.offset() + qualifiedLoc.length();
    const candidateText = candidate.completionText()!;
    const targetTo = updateFrom <= UpdatePatchStartingFrom.Candidate
        ? originalTargetTo
        : targetFrom + candidateText.length;
    const qualifiedFrom = qualifiedLoc.offset();
    const qualifiedTo = updateFrom <= UpdatePatchStartingFrom.Candidate
        ? originalQualifiedTo
        : originalQualifiedTo + candidateText.length - (originalTargetTo - targetFrom);

    // Update candidate patch?
    if (updateFrom <= UpdatePatchStartingFrom.Candidate) {
        nextState = copyLazily(nextState, prevState);
        nextState.candidatePatch = [];
        nextState.catalogObjectPatch = [];

        const currentText = text.sliceString(targetFrom, targetTo);
        nextState.candidatePatch = completionDiff(targetFrom, currentText, candidateText, CompletionPatchTarget.Candidate, cursor);
    }

    // Keyword continuation?
    const keywordContinuation = candidate.keywordContinuation();
    if (keywordContinuation && updateFrom <= UpdatePatchStartingFrom.CatalogObject) {
        nextState = copyLazily(nextState, prevState);
        const insertAt = updateFrom <= UpdatePatchStartingFrom.Candidate
            ? targetTo
            : targetFrom + candidateText.length;
        nextState.catalogObjectPatch = [{
            target: CompletionPatchTarget.CatalogObject,
            type: PATCH_INSERT_TEXT,
            value: { at: insertAt, text: " " + keywordContinuation, textAnchor: TextAnchor.Left },
        }];
        return nextState;
    }

    // Read catalog object
    const catalogObjectId = prevState.catalogObjectId;
    if (catalogObjectId >= candidate.catalogObjectsLength()) {
        return nextState;
    }
    const catalogObject = candidate.catalogObjects(catalogObjectId)!;

    // Update catalog object patch?
    if (updateFrom <= UpdatePatchStartingFrom.CatalogObject
        && (catalogObject.preferQualified() || shouldAutoQualifyNonDefaultTable(catalogObject))) {
        nextState = copyLazily(nextState, prevState);
        nextState.catalogObjectPatch = [];

        // Qualification prefix
        let name = unpackQualifiedObjectName(catalogObject);
        let qualPrefix = name.slice(0, catalogObject.qualifiedNameTargetIdx());
        if (qualPrefix.length > 0) {
            let have = text.sliceString(qualifiedFrom, targetFrom);
            let want = qualPrefix.join(".") + ".";
            let patch = completionDiff(qualifiedFrom, have, want, CompletionPatchTarget.CatalogObject, cursor);
            nextState.catalogObjectPatch = patch;
        }

        // Qualification suffix
        let qualSuffix = name.slice(catalogObject.qualifiedNameTargetIdx() + 1);
        if (qualSuffix.length > 0) {
            let have = text.sliceString(targetTo, qualifiedTo);
            let want = "." + qualSuffix.join(".");
            let patch = completionDiff(targetTo, have, want, CompletionPatchTarget.CatalogObject, cursor);
            nextState.catalogObjectPatch = nextState.catalogObjectPatch.concat(patch);
        }
    }

    return nextState;
}

export function updateCursorWithCompletion(patch: CompletionPatch[], cursorAt: number): number {
    let out = cursorAt;
    for (const p of patch) {
        switch (p.type) {
            case PATCH_DELETE_TEXT:
                if (p.value.at < cursorAt) {
                    const to = Math.min(p.value.at + p.value.length, cursorAt);
                    const deleteBeforeCursor = to - p.value.at;
                    out -= deleteBeforeCursor;
                }
                break;
            case PATCH_INSERT_TEXT:
                if (p.value.at <= cursorAt) {
                    out += p.value.text.length;
                }
                break;
        }
    }
    return out;
}

export function applyCompletion(patch: CompletionPatch[]): ChangeSpec {
    const out: ChangeSpec[] = [];
    for (const p of patch) {
        switch (p.type) {
            case PATCH_DELETE_TEXT:
                out.push({
                    from: p.value.at,
                    to: p.value.at + p.value.length,
                });
                break;
            case PATCH_INSERT_TEXT:
                out.push({
                    from: p.value.at,
                    insert: p.value.text
                });
                break;
        }
    }
    return out;
}
