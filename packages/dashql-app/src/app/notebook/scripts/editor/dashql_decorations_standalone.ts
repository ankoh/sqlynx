import * as dashql from '@ankoh/dashql-core';

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorState, Extension, StateEffect, type StateEffectType, StateField, Transaction, RangeSetBuilder } from '@codemirror/state';
import { highlightingFor } from '@codemirror/language';
import { tags as CODEMIRROR_TAGS, Tag } from '@lezer/highlight';

import './dashql_decorations.css';

export const visKeywordTag = Tag.define(CODEMIRROR_TAGS.keyword);
export const commentTag = CODEMIRROR_TAGS.comment;
const relationNameTag = CODEMIRROR_TAGS.typeName;
const functionNameTag = CODEMIRROR_TAGS.function(CODEMIRROR_TAGS.variableName);

const PROTO_TAG_MAPPING: Map<dashql.buffers.parser.ScannerTokenType, Tag> = new Map([
    [dashql.buffers.parser.ScannerTokenType.KEYWORD, CODEMIRROR_TAGS.keyword],
    [dashql.buffers.parser.ScannerTokenType.KEYWORD_VIS, visKeywordTag],
    [dashql.buffers.parser.ScannerTokenType.OPERATOR, CODEMIRROR_TAGS.operator],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_BINARY, CODEMIRROR_TAGS.literal],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_BOOLEAN, CODEMIRROR_TAGS.bool],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_FLOAT, CODEMIRROR_TAGS.float],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_HEX, CODEMIRROR_TAGS.number],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_STRING, CODEMIRROR_TAGS.string],
    [dashql.buffers.parser.ScannerTokenType.LITERAL_INTEGER, CODEMIRROR_TAGS.integer],
    [dashql.buffers.parser.ScannerTokenType.IDENTIFIER, CODEMIRROR_TAGS.name],
]);

const CODEMIRROR_TAGS_USED: Set<Tag> = new Set([commentTag, relationNameTag, functionNameTag]);
for (const [_token, tag] of PROTO_TAG_MAPPING) {
    CODEMIRROR_TAGS_USED.add(tag);
}

/// Build the tag -> decoration lookup for the current editor state (theme dependent).
function buildTagDecorations(state: EditorState): Map<Tag, Decoration> {
    const decorations: Map<Tag, Decoration> = new Map();
    for (const tag of CODEMIRROR_TAGS_USED) {
        const highlightClass = highlightingFor(state, [tag]) ?? '';
        decorations.set(
            tag,
            Decoration.mark({
                class: tag === commentTag
                    ? `${highlightClass} dashql-comment`.trim()
                    : highlightClass,
            }),
        );
    }
    return decorations;
}

/// Build syntax highlighting decorations for the tokens that fall into the given ranges.
///
/// This only touches the tokens overlapping `ranges` (the editor viewport), not the whole
/// document. On a large script decorating every token synchronously blocks the main thread;
/// slicing the sorted portable syntax spans to the viewport keeps it O(visible).
export function buildDecorationsForRanges(
    state: EditorState,
    update: dashql.buffers.editor.EditorUpdateT,
    ranges: readonly { from: number; to: number }[],
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const decorations = buildTagDecorations(state);
    const semanticNames = update.semanticSpans.filter(semantic =>
        semantic.textSpan != null && (
            semantic.kind === dashql.buffers.editor.EditorSemanticReferenceKind.TABLE ||
            semantic.kind === dashql.buffers.editor.EditorSemanticReferenceKind.FUNCTION
        ),
    );
    let semanticCursor = 0;
    let spanCursor = 0;
    for (const { from, to } of ranges) {
        while (spanCursor < update.syntaxSpans.length) {
            const syntax = update.syntaxSpans[spanCursor];
            const span = syntax.textSpan;
            if (span == null) {
                ++spanCursor;
                continue;
            }
            const spanFrom = Number(span.offset);
            const spanTo = Number(span.offset + span.length);
            if (spanTo <= from) {
                ++spanCursor;
                continue;
            }
            if (spanFrom >= to) break;
            let tag = syntax.tokenType === dashql.buffers.parser.ScannerTokenType.COMMENT
                ? commentTag
                : PROTO_TAG_MAPPING.get(syntax.tokenType);
            if (syntax.tokenType === dashql.buffers.parser.ScannerTokenType.IDENTIFIER) {
                while (semanticCursor < semanticNames.length) {
                    const semanticSpan = semanticNames[semanticCursor].textSpan!;
                    if (Number(semanticSpan.offset + semanticSpan.length) > spanFrom) break;
                    ++semanticCursor;
                }
                const semantic = semanticNames[semanticCursor];
                const semanticSpan = semantic?.textSpan;
                const semanticKind = semanticSpan != null && Number(semanticSpan.offset) <= spanFrom &&
                        Number(semanticSpan.offset + semanticSpan.length) >= spanTo
                    ? semantic.kind
                    : null;
                switch (semanticKind) {
                    case dashql.buffers.editor.EditorSemanticReferenceKind.TABLE:
                        tag = relationNameTag;
                        break;
                    case dashql.buffers.editor.EditorSemanticReferenceKind.FUNCTION:
                        tag = functionNameTag;
                        break;
                }
            }
            if (tag) builder.add(spanFrom, spanTo, decorations.get(tag)!);
            ++spanCursor;
        }
    }
    return builder.finish();
}

/// A ViewPlugin that highlights only the visible tokens.
///
/// `getUpdate` resolves the portable editor projection for the current view: the integrated editor reads it
/// from the processor state field, the standalone preview from an effect-backed field. Decorations
/// are recomputed when the viewport scrolls, the document changes, or the projection is swapped.
export function createScannerHighlightPlugin(
    getUpdate: (view: EditorView) => dashql.buffers.editor.EditorUpdateT | null,
): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            lastUpdate: dashql.buffers.editor.EditorUpdateT | null;

            constructor(view: EditorView) {
                this.lastUpdate = getUpdate(view);
                this.decorations = this.lastUpdate
                    ? buildDecorationsForRanges(view.state, this.lastUpdate, view.visibleRanges)
                    : Decoration.none;
                console.debug('[notebook-editor-debug] initialized syntax highlighting', {
                    hasProjection: this.lastUpdate != null,
                    documentRevision: this.lastUpdate?.documentRevision,
                    stateRevision: this.lastUpdate?.stateRevision,
                    syntaxSpanCount: this.lastUpdate?.syntaxSpans.length ?? 0,
                    semanticSpanCount: this.lastUpdate?.semanticSpans.length ?? 0,
                    visibleRanges: view.visibleRanges.map(range => `${range.from}-${range.to}`).join(','),
                    documentLength: view.state.doc.length,
                    decorationCount: this.decorations.size,
                });
            }
            update(u: ViewUpdate) {
                const update = getUpdate(u.view);
                const projectionChanged = update !== this.lastUpdate;
                if (u.viewportChanged || u.docChanged || projectionChanged) {
                    this.lastUpdate = update;
                    this.decorations = update
                        ? buildDecorationsForRanges(u.view.state, update, u.view.visibleRanges)
                        : Decoration.none;
                    console.debug('[notebook-editor-debug] rebuilt syntax highlighting', {
                        hasProjection: update != null,
                        projectionChanged,
                        viewportChanged: u.viewportChanged,
                        docChanged: u.docChanged,
                        documentRevision: update?.documentRevision,
                        stateRevision: update?.stateRevision,
                        syntaxSpanCount: update?.syntaxSpans.length ?? 0,
                        semanticSpanCount: update?.semanticSpans.length ?? 0,
                        visibleRanges: u.view.visibleRanges.map(range => `${range.from}-${range.to}`).join(','),
                        documentLength: u.view.state.doc.length,
                        decorationCount: this.decorations.size,
                    });
                }
            }
        },
        { decorations: v => v.decorations },
    );
}

export const DashQLScannerDecorationUpdateEffect: StateEffectType<dashql.buffers.editor.EditorUpdateT | null> =
    StateEffect.define<dashql.buffers.editor.EditorUpdateT | null>();

/// Holds the editor projection pushed in from outside via DashQLScannerDecorationUpdateEffect.
/// The highlight ViewPlugin reads it back out to decorate the viewport.
const StandaloneUpdateField: StateField<dashql.buffers.editor.EditorUpdateT | null> =
    StateField.define<dashql.buffers.editor.EditorUpdateT | null>({
        create: () => null,
        update: (update, transaction: Transaction) => {
            for (const effect of transaction.effects) {
                if (effect.is(DashQLScannerDecorationUpdateEffect)) {
                    update = effect.value;
                }
            }
            return update;
        },
    });

export const DashQLStandaloneScannerDecorationPlugin = [
    StandaloneUpdateField,
    createScannerHighlightPlugin(view => view.state.field(StandaloneUpdateField)),
];
