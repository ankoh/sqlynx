import * as dashql from '@ankoh/dashql-core';

import {
    EditorSelection,
    EditorState,
    Prec,
    StateEffect,
    StateEffectType,
    StateField,
    Transaction,
} from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap } from '@codemirror/view';

import { DashQLProcessorPlugin } from './dashql_processor.js';

export type TombstoneQuote = '"' | "'" | '`';

export interface QuoteTombstone {
    leading: number;
    trailing: number;
    char: TombstoneQuote;
}

const ArmTombstoneEffect: StateEffectType<QuoteTombstone> = StateEffect.define<QuoteTombstone>();
const ClearTombstoneEffect: StateEffectType<null> = StateEffect.define<null>();

const isTombstoneQuote = (c: string): c is TombstoneQuote => c === '"' || c === "'" || c === '`';

const tombstoneMark = Decoration.mark({ class: 'dashql-quote-tombstoned' });

export const QuoteTombstoneField: StateField<QuoteTombstone | null> = StateField.define<QuoteTombstone | null>({
    create: () => null,
    update: (state, tr) => {
        let armed: QuoteTombstone | null | 'cleared' = null;
        for (const effect of tr.effects) {
            if (effect.is(ArmTombstoneEffect)) {
                armed = effect.value;
            } else if (effect.is(ClearTombstoneEffect)) {
                armed = 'cleared';
            }
        }
        if (armed === 'cleared') return null;
        if (armed) return armed;
        if (!state) return null;

        // Map positions through doc changes; clear if the quotes are gone
        let leading = state.leading;
        let trailing = state.trailing;
        if (tr.docChanged) {
            leading = tr.changes.mapPos(state.leading, -1);
            trailing = tr.changes.mapPos(state.trailing, 1);
            const doc = tr.newDoc;
            if (leading < 0 || trailing >= doc.length) return null;
            if (leading >= trailing) return null;
            if (doc.sliceString(leading, leading + 1) !== state.char) return null;
            if (doc.sliceString(trailing, trailing + 1) !== state.char) return null;
        }

        // Clear when the cursor leaves the token span [leading, trailing+1]
        const sel = tr.newSelection.main;
        if (sel.head < leading || sel.head > trailing + 1) return null;
        if (sel.anchor < leading || sel.anchor > trailing + 1) return null;

        if (leading !== state.leading || trailing !== state.trailing) {
            return { ...state, leading, trailing };
        }
        return state;
    },
});

const QuoteTombstoneDecorationsField: StateField<DecorationSet> = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (_deco, tr) => {
        const t = tr.state.field(QuoteTombstoneField);
        if (!t) return Decoration.none;
        return Decoration.set([
            tombstoneMark.range(t.leading, t.leading + 1),
            tombstoneMark.range(t.trailing, t.trailing + 1),
        ]);
    },
    provide: f => EditorView.decorations.from(f),
});

export interface QuotedTokenSpan {
    leading: number;
    trailing: number;
}

/// Finder for the quoted token containing `quotePos`.
/// Default lookup uses the DashQL processor's scanner tokens; tests can inject a fake.
export type QuotedTokenFinder = (state: EditorState, quotePos: number) => QuotedTokenSpan | null;

export const defaultQuotedTokenFinder: QuotedTokenFinder = (state, quotePos) => {
    const processor = state.field(DashQLProcessorPlugin, false);
    if (!processor) return null;
    const token = processor.editorUpdate?.syntaxSpans.find(({ textSpan }) => {
        if (textSpan == null) return false;
        const from = Number(textSpan.offset);
        return from <= quotePos && quotePos < from + Number(textSpan.length);
    });
    const offset = Number(token?.textSpan?.offset ?? 0n);
    const length = Number(token?.textSpan?.length ?? 0n);
    if (length < 2) return null;
    return {
        leading: offset,
        trailing: offset + length - 1,
    };
};

interface QuoteTokenInfo {
    leading: number;
    trailing: number;
    char: TombstoneQuote;
    targetIsTrailing: boolean;
}

function resolveQuoteToken(
    state: EditorState,
    quotePos: number,
    finder: QuotedTokenFinder,
): QuoteTokenInfo | null {
    if (quotePos < 0 || quotePos >= state.doc.length) return null;
    const ch = state.doc.sliceString(quotePos, quotePos + 1);
    if (!isTombstoneQuote(ch)) return null;
    const span = finder(state, quotePos);
    if (!span) return null;
    if (quotePos !== span.leading && quotePos !== span.trailing) return null;
    if (state.doc.sliceString(span.leading, span.leading + 1) !== ch) return null;
    if (state.doc.sliceString(span.trailing, span.trailing + 1) !== ch) return null;
    return { leading: span.leading, trailing: span.trailing, char: ch, targetIsTrailing: quotePos === span.trailing };
}

// Replace the entire tombstoned token with its inner text in one change so the doc->script
// mirror in DashQLProcessorPlugin sees a single contiguous edit (multi-change deletes use
// original-doc offsets that the script's sequential erase can't apply correctly).
function dispatchTombstoneCommit(
    view: EditorView,
    tombstone: QuoteTombstone,
    cursor: number,
    userEvent: 'delete.backward' | 'delete.forward',
): void {
    const inner = view.state.doc.sliceString(tombstone.leading + 1, tombstone.trailing);
    let nextCursor = cursor;
    if (cursor > tombstone.leading) nextCursor -= 1;
    if (cursor > tombstone.trailing) nextCursor -= 1;
    view.dispatch({
        changes: { from: tombstone.leading, to: tombstone.trailing + 1, insert: inner },
        selection: EditorSelection.cursor(nextCursor),
        effects: ClearTombstoneEffect.of(null),
        annotations: Transaction.userEvent.of(userEvent),
    });
}

export function tombstoneBackspace(view: EditorView, finder: QuotedTokenFinder): boolean {
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const cursor = sel.head;
    const tombstone = state.field(QuoteTombstoneField, false);

    if (tombstone) {
        const target = cursor - 1;
        if (target === tombstone.leading || target === tombstone.trailing) {
            dispatchTombstoneCommit(view, tombstone, cursor, 'delete.backward');
            return true;
        }
        return false;
    }

    if (cursor === 0) return false;
    const info = resolveQuoteToken(state, cursor - 1, finder);
    if (!info) return false;
    const tomb: QuoteTombstone = { leading: info.leading, trailing: info.trailing, char: info.char };
    if (info.targetIsTrailing) {
        view.dispatch({
            selection: EditorSelection.cursor(cursor - 1),
            effects: ArmTombstoneEffect.of(tomb),
        });
    } else {
        view.dispatch({
            effects: ArmTombstoneEffect.of(tomb),
        });
    }
    return true;
}

export function tombstoneForwardDelete(view: EditorView, finder: QuotedTokenFinder): boolean {
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const cursor = sel.head;
    const tombstone = state.field(QuoteTombstoneField, false);

    if (tombstone) {
        const target = cursor;
        if (target === tombstone.leading || target === tombstone.trailing) {
            dispatchTombstoneCommit(view, tombstone, cursor, 'delete.forward');
            return true;
        }
        return false;
    }

    if (cursor >= state.doc.length) return false;
    const info = resolveQuoteToken(state, cursor, finder);
    if (!info) return false;
    const tomb: QuoteTombstone = { leading: info.leading, trailing: info.trailing, char: info.char };
    view.dispatch({
        effects: ArmTombstoneEffect.of(tomb),
    });
    return true;
}

export const onTombstoneBackspace = (view: EditorView): boolean => tombstoneBackspace(view, defaultQuotedTokenFinder);
export const onTombstoneForwardDelete = (view: EditorView): boolean =>
    tombstoneForwardDelete(view, defaultQuotedTokenFinder);

export const DashQLQuoteTombstonePlugin = [
    QuoteTombstoneField,
    QuoteTombstoneDecorationsField,
    Prec.highest(
        keymap.of([
            { key: 'Backspace', run: onTombstoneBackspace },
            { key: 'Delete', run: onTombstoneForwardDelete },
        ]),
    ),
];
