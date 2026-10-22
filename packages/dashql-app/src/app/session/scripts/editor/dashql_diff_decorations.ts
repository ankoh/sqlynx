import * as dashql from '@ankoh/dashql-core';

import { Decoration, DecorationSet, EditorView, gutter, GutterMarker } from '@codemirror/view';
import { Extension, Range, StateField, Text, Transaction } from '@codemirror/state';

import { DashQLPendingDiff, DashQLProcessorPlugin } from './dashql_processor.js';

import './dashql_diff_decorations.css';

/// The sentinel that ScriptDiffOp uses for an absent statement (no source for INSERT, no target
/// for DELETE). Must match the `.fbs` default (0xFFFFFFFF).
const STATEMENT_NONE = 0xffffffff;

const OpCode = dashql.buffers.diff.ScriptDiffOpCode;

/// Whole inserted statement (present in the new text, absent from the prior one)
const InsertStatementDecoration = Decoration.mark({ class: 'cm-dashql-diff-insert' });
/// An updated statement — subtle tint over the whole statement
const UpdateStatementDecoration = Decoration.mark({ class: 'cm-dashql-diff-update' });
/// A statement that only moved (order changed but content equal)
const MoveStatementDecoration = Decoration.mark({ class: 'cm-dashql-diff-move' });
/// A changed sub-range within an updated statement — stronger highlight
const ChangeDecoration = Decoration.mark({ class: 'cm-dashql-diff-change' });

/// A gutter marker for a deleted statement.
///
/// A deletion has no target span (the statement is gone from the new text), so we cannot highlight
/// it in place. Instead we drop a thin marker in the gutter at the nearest surviving boundary.
class DeleteMarker extends GutterMarker {
    toDOM() {
        const span = document.createElement('span');
        span.className = 'dashql-gutter-diff-delete';
        return span;
    }
}

interface DiffDecorationState {
    /// The pending diff this state was built from (identity used to skip rebuilds)
    pendingDiff: DashQLPendingDiff | null;
    /// The in-place highlight decorations
    decorations: DecorationSet;
    /// The `line.from` offsets that carry a "statement deleted here" gutter marker
    deleteLines: Set<number>;
}

/// Build the in-place diff decorations and delete-gutter anchors from a pending diff.
///
/// The editor holds the *new* (target) text, so `target_span` / `target_changes` are text offsets
/// into the current document; no token resolution is needed on the JS side. Deletions have no
/// target span, so we anchor their gutter marker at the end of the most recently seen surviving
/// statement (falling back to the document start).
function buildDiffDecorations(pending: DashQLPendingDiff | null, doc: Text): DiffDecorationState {
    if (pending == null) {
        return { pendingDiff: null, decorations: Decoration.none, deleteLines: new Set() };
    }
    const diff = pending.diffBuffer.read();
    const docLength = doc.length;
    const ranges: Range<Decoration>[] = [];
    const deleteLines = new Set<number>();

    const tmpOp = new dashql.buffers.diff.ScriptDiffOp();
    const tmpSpan = new dashql.buffers.parser.TextSpan();
    const tmpChange = new dashql.buffers.parser.TextSpan();

    // Clamp a span to the current document, dropping empty/inverted ranges. Guards against any
    // transient mismatch between the diff and the editor doc.
    const clamp = (from: number, to: number): [number, number] | null => {
        const f = Math.max(0, Math.min(from, docLength));
        const t = Math.max(f, Math.min(to, docLength));
        return f < t ? [f, t] : null;
    };

    // The end offset of the most recently seen surviving statement — the anchor for the next
    // deletion's gutter marker.
    let lastTargetEnd = 0;

    for (let i = 0; i < diff.opsLength(); ++i) {
        const op = diff.ops(i, tmpOp)!;
        const code = op.code();

        if (code === OpCode.DELETE || op.targetStatement() === STATEMENT_NONE) {
            // A deletion (or any op without a target) drops a gutter marker at the nearest boundary.
            if (code === OpCode.DELETE) {
                const anchor = Math.max(0, Math.min(lastTargetEnd, docLength));
                deleteLines.add(doc.lineAt(anchor).from);
            }
            continue;
        }

        const targetSpan = op.targetSpan(tmpSpan);
        if (targetSpan == null) {
            continue;
        }
        const range = clamp(
            targetSpan.offset(),
            targetSpan.offset() + targetSpan.length(),
        );
        if (range == null) {
            continue;
        }
        lastTargetEnd = range[1];

        switch (code) {
            case OpCode.INSERT:
                ranges.push(InsertStatementDecoration.range(range[0], range[1]));
                break;
            case OpCode.MOVE:
                ranges.push(MoveStatementDecoration.range(range[0], range[1]));
                break;
            case OpCode.UPDATE: {
                ranges.push(UpdateStatementDecoration.range(range[0], range[1]));
                for (let j = 0; j < op.targetChangesLength(); ++j) {
                    const change = op.targetChanges(j, tmpChange);
                    if (change == null) continue;
                    const cr = clamp(
                        change.offset(),
                        change.offset() + change.length(),
                    );
                    if (cr == null) continue;
                    ranges.push(ChangeDecoration.range(cr[0], cr[1]));
                }
                break;
            }
            case OpCode.KEEP:
            default:
                // Unchanged statements are not decorated.
                break;
        }
    }

    return {
        pendingDiff: pending,
        // `sort` handles the nested change-within-update ranges and the emit order.
        decorations: Decoration.set(ranges, true),
        deleteLines,
    };
}

/// Build the staged-rewrite decorations for the writable editor.
function createDiffDecorationExtension(): Extension {
    /// Decorations for a pending, staged rewrite shown as an in-place diff.
    const field: StateField<DiffDecorationState> = StateField.define<DiffDecorationState>({
        create: () => ({ pendingDiff: null, decorations: Decoration.none, deleteLines: new Set() }),
        update: (state: DiffDecorationState, transaction: Transaction) => {
            const pending = transaction.state.field(DashQLProcessorPlugin).scriptPendingDiff;
            // Pending diff unchanged and doc untouched? Keep the previous decorations.
            if (pending === state.pendingDiff && !transaction.docChanged) {
                return state;
            }
            return buildDiffDecorations(pending, transaction.state.doc);
        },
    });

    const decorations = EditorView.decorations.from(field, state => state.decorations);

    /// A dedicated gutter that marks lines where statements were deleted by the pending rewrite.
    const diffGutter = gutter({
        lineMarker(view, line) {
            const state = view.state.field(field);
            return state.deleteLines.has(line.from) ? new DeleteMarker() : null;
        },
        lineMarkerChange: (update) => {
            const prev = update.startState.field(field);
            const next = update.state.field(field);
            return prev.deleteLines !== next.deleteLines;
        },
    });

    return [field, decorations, diffGutter];
}

/// Bundle the diff decoration extensions for the integrated (editable) editor — the pending diff
/// comes from the `DashQLProcessorPlugin` state field, kept in sync with the session's ScriptData.
export const DashQLDiffDecorationPlugin = createDiffDecorationExtension();
