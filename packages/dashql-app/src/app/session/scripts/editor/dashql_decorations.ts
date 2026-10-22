import * as dashql from '@ankoh/dashql-core';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Transaction, StateField, RangeSetBuilder } from '@codemirror/state';

import { DashQLProcessorPlugin, DashQLScriptKey } from './dashql_processor.js';
import { createScannerHighlightPlugin } from './dashql_decorations_standalone.js';
import { FocusType, SemanticUserFocus } from '../focus.js';

import './dashql_decorations.css';

const CursorTableReference = Decoration.mark({
    class: 'dashql-tableref-cursor',
});
const FocusedTableReferenceDecoration = Decoration.mark({
    class: 'dashql-tableref-focus',
});
const ResolvedTableReferenceDecoration = Decoration.mark({
    class: 'dashql-tableref-resolved',
});
const UnresolvedTableReferenceDecoration = Decoration.mark({
    class: 'dashql-tableref-unresolved',
});
const CursorColumnReference = Decoration.mark({
    class: 'dashql-colref-cursor',
});
const FocusedColumnReferenceDecoration = Decoration.mark({
    class: 'dashql-colref-focus',
});
const ResolvedColumnReferenceDecoration = Decoration.mark({
    class: 'dashql-colref-resolved',
});
const UnresolvedColumnReferenceDecoration = Decoration.mark({
    class: 'dashql-colref-unresolved',
});
const FunctionReferenceDecoration = Decoration.mark({
    class: 'dashql-function-ref',
});
const ErrorDecoration = Decoration.mark({
    class: 'dashql-error',
});
const WarningDecoration = Decoration.mark({
    class: 'dashql-warning',
});

function buildDecorationsFromErrors(
    update: dashql.buffers.editor.EditorUpdateT | null | undefined,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const decorations: DecorationInfo[] = [];
    for (const diagnostic of update?.diagnostics ?? []) {
        const span = diagnostic.textSpan;
        if (span == null) continue;
        decorations.push({
            from: Number(span.offset),
            to: Number(span.offset + span.length),
            decoration: diagnostic.severity === dashql.buffers.editor.EditorDiagnosticSeverity.WARNING
                ? WarningDecoration
                : ErrorDecoration,
        });
    }

    decorations.sort((l: DecorationInfo, r: DecorationInfo) => {
        return l.from - r.from;
    });
    for (const deco of decorations) {
        builder.add(deco.from, deco.to, deco.decoration);
    }
    return builder.finish();
}

function buildDecorationsFromAnalysis(
    update: dashql.buffers.editor.EditorUpdateT | null | undefined,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const decorations: DecorationInfo[] = [];
    for (const semantic of update?.semanticSpans ?? []) {
        const span = semantic.textSpan;
        if (span == null) continue;
        const resolved = semantic.resolution === dashql.buffers.editor.EditorSemanticResolution.RESOLVED;
        let decoration: Decoration;
        switch (semantic.kind) {
            case dashql.buffers.editor.EditorSemanticReferenceKind.TABLE:
                decoration = resolved ? ResolvedTableReferenceDecoration : UnresolvedTableReferenceDecoration;
                break;
            case dashql.buffers.editor.EditorSemanticReferenceKind.COLUMN:
                decoration = resolved ? ResolvedColumnReferenceDecoration : UnresolvedColumnReferenceDecoration;
                break;
            case dashql.buffers.editor.EditorSemanticReferenceKind.FUNCTION:
                decoration = FunctionReferenceDecoration;
                break;
        }
        decorations.push({
            from: Number(span.offset),
            to: Number(span.offset + span.length),
            decoration,
        });
    }
    decorations.sort((l: DecorationInfo, r: DecorationInfo) => {
        return l.from - r.from;
    });
    for (const deco of decorations) {
        builder.add(deco.from, deco.to, deco.decoration);
    }
    return builder.finish();
}

function buildDecorationsFromFocus(
    scriptKey: DashQLScriptKey | null,
    update: dashql.buffers.editor.EditorUpdateT | null | undefined,
    derivedFocus: SemanticUserFocus | null,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const decorations: DecorationInfo[] = [];

    const spans = update?.semanticSpans ?? [];

    // Build decorations for column refs of targeting the primary table
    for (const [refId, focusType] of derivedFocus?.scriptColumnRefs ?? []) {
        const externalId = dashql.ExternalObjectID.getOrigin(refId);
        const objectId = dashql.ExternalObjectID.getObject(refId);
        if (externalId !== scriptKey) {
            continue;
        }
        // XXX invalidate focused table refs at write front
        const ts = spans.find(span => span.kind === dashql.buffers.editor.EditorSemanticReferenceKind.COLUMN
            && span.referenceId === objectId)?.textSpan;
        if (ts == null) continue;

        // Get decoration
        let decoration: Decoration;
        switch (focusType) {
            case FocusType.COLUMN_REF_UNDER_CURSOR:
                decoration = CursorColumnReference;
                break;
            default:
                decoration = FocusedColumnReferenceDecoration;
                break;
        }
        decorations.push({
            from: Number(ts.offset),
            to: Number(ts.offset + ts.length),
            decoration: decoration,
        });
    }

    // Build decorations for table refs targeting the primary table
    for (const [refId, focusType] of derivedFocus?.scriptTableRefs ?? []) {
        const externalId = dashql.ExternalObjectID.getOrigin(refId);
        const objectId = dashql.ExternalObjectID.getObject(refId);
        if (externalId !== scriptKey) {
            continue;
        }
        // XXX invalidate focused table refs at write front
        const ts = spans.find(span => span.kind === dashql.buffers.editor.EditorSemanticReferenceKind.TABLE
            && span.referenceId === objectId)?.textSpan;
        if (ts == null) continue;

        // Get decoration
        let decoration: Decoration;
        switch (focusType) {
            case FocusType.TABLE_REF_UNDER_CURSOR:
                decoration = CursorTableReference;
                break;
            default:
                decoration = FocusedTableReferenceDecoration;
                break;
        }
        decorations.push({
            from: Number(ts.offset),
            to: Number(ts.offset + ts.length),
            decoration: decoration,
        });
    }
    decorations.sort((l: DecorationInfo, r: DecorationInfo) => {
        return l.from - r.from;
    });
    for (const deco of decorations) {
        builder.add(deco.from, deco.to, deco.decoration);
    }
    return builder.finish();
}


interface DecorationInfo {
    from: number;
    to: number;
    decoration: Decoration;
}


interface ScriptDecorationState {
    decorations: DecorationSet;
    editorUpdate: dashql.buffers.editor.EditorUpdateT | null | undefined;
}

/// Syntax highlighting derived from the portable editor projection.
/// Viewport-limited: decorates only the visible spans.
const ScannerHighlightPlugin = createScannerHighlightPlugin(
    view => view.state.field(DashQLProcessorPlugin).editorUpdate ?? null,
);

/// Decorations for scanner, parser or analyzer errors in the DashQL script
const ErrorDecorationField: StateField<ScriptDecorationState> = StateField.define<ScriptDecorationState>({
    create: () => {
        const config: ScriptDecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            editorUpdate: null,
        };
        return config;
    },
    update: (state: ScriptDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(DashQLProcessorPlugin);
        if (processor.editorUpdate === state.editorUpdate) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.editorUpdate = processor.editorUpdate;
        s.decorations = buildDecorationsFromErrors(s.editorUpdate);
        return s;
    },
});

const AnalyzerDecorationsField: StateField<ScriptDecorationState> = StateField.define<ScriptDecorationState>({
    create: () => {
        const config: ScriptDecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            editorUpdate: null,
        };
        return config;
    },
    update: (state: ScriptDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(DashQLProcessorPlugin);
        if (processor.editorUpdate === state.editorUpdate) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.editorUpdate = processor.editorUpdate;
        s.decorations = buildDecorationsFromAnalysis(s.editorUpdate);
        return s;
    },
});

interface FocusDecorationState {
    scriptKey: DashQLScriptKey | null;
    decorations: DecorationSet;
    editorUpdate: dashql.buffers.editor.EditorUpdateT | null | undefined;
    derivedFocus: SemanticUserFocus | null;
}

/// Decorations derived from the user focus
const FocusDecorationField: StateField<FocusDecorationState> = StateField.define<FocusDecorationState>({
    // Create the initial state
    create: () => {
        const config: FocusDecorationState = {
            scriptKey: null,
            decorations: new RangeSetBuilder<Decoration>().finish(),
            editorUpdate: null,
            derivedFocus: null,
        };
        return config;
    },
    // Mirror the DashQL state
    update: (state: FocusDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(DashQLProcessorPlugin);
        if (
            processor.scriptKey === state.scriptKey &&
            processor.editorUpdate === state.editorUpdate &&
            processor.derivedFocus === state.derivedFocus
        ) {
            return state;
        }
        // Rebuild decorations from the portable UTF-16 projection.
        const s = { ...state };
        s.scriptKey = processor.scriptKey;
        s.editorUpdate = processor.editorUpdate;
        s.derivedFocus = processor.derivedFocus;
        s.decorations = buildDecorationsFromFocus(
            s.scriptKey,
            s.editorUpdate,
            s.derivedFocus,
        );
        return s;
    },
});

const ErrorDecorations = EditorView.decorations.from(ErrorDecorationField, state => state.decorations);
const AnalyzerDecorations = EditorView.decorations.from(AnalyzerDecorationsField, state => state.decorations);
const FocusDecorations = EditorView.decorations.from(FocusDecorationField, state => state.decorations);

export const DashQLScannerDecorationPlugin = [ScannerHighlightPlugin];

/// Bundle the decoration extensions
export const DashQLDecorationPlugin = [ScannerHighlightPlugin, ErrorDecorationField, ErrorDecorations, AnalyzerDecorationsField, AnalyzerDecorations, FocusDecorationField, FocusDecorations];
