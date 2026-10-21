import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, KeyBinding, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view';

import {
    CatalogNameIndex,
    CatalogNameKind,
    EMPTY_CATALOG_NAME_INDEX,
    findIdentifierMatches,
    isIdentifierCandidate,
    lookupIdentifier,
    lookupPrefix,
} from '../../ai/catalog_name_index.js';

import * as styles from './nl_identifier_plugin.module.css';

/// An unqualified word needs this many characters before we hint a completion
const HINT_MIN_PREFIX_LENGTH = 4;
/// A prefix with more distinct candidates is too ambiguous to hint
const HINT_MAX_CANDIDATES = 5;

/// A character of an identifier word
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
/// The first character of an identifier word
const WORD_START = /[\p{L}_]/u;

/// Effect to replace the catalog name index
export const NLIdentifierIndexEffect = StateEffect.define<CatalogNameIndex>();

/// The catalog name index of the editor.
/// Lives outside the mode-dependent extensions so the index survives switching the input mode.
export const NLIdentifierIndex = StateField.define<CatalogNameIndex>({
    create: () => EMPTY_CATALOG_NAME_INDEX,
    update: (index, tr) => {
        for (const effect of tr.effects) {
            if (effect.is(NLIdentifierIndexEffect)) index = effect.value;
        }
        return index;
    },
});

/// A completion hint shown as ghost text after the cursor
export interface NLIdentifierHint {
    /// The cursor the hint is anchored at
    cursor: number;
    /// The text that accepting the hint inserts at the cursor
    insert: string;
}

/// Effect to drop the completion hint
const NLIdentifierHintDismissEffect = StateEffect.define<null>();

/// Rank a candidate name, lower is better
function rankCandidate(index: CatalogNameIndex, key: string, mentionedTables: Set<string>): number {
    let rank = 2;
    for (const name of index.byKey.get(key) ?? []) {
        if (name.kind === CatalogNameKind.Column && name.table != null && mentionedTables.has(name.table.toLowerCase())) {
            return 0;
        }
        if (name.kind === CatalogNameKind.Table) {
            rank = 1;
        }
    }
    return rank;
}

/// Compute the completion hint for the word that ends at the cursor, if we are confident enough
export function computeNLIdentifierHint(state: EditorState): NLIdentifierHint | null {
    const selection = state.selection.main;
    if (!selection.empty) {
        return null;
    }
    const cursor = selection.head;
    const line = state.doc.lineAt(cursor);
    const text = line.text;
    const offset = cursor - line.from;
    // The word must end at the cursor
    if (offset < text.length && WORD_CHAR.test(text[offset])) {
        return null;
    }
    let begin = offset;
    while (begin > 0 && WORD_CHAR.test(text[begin - 1])) {
        --begin;
    }
    const word = text.substring(begin, offset);
    if (word.length === 0 || !WORD_START.test(word[0])) {
        return null;
    }
    const index = state.field(NLIdentifierIndex);

    // A qualified word completes the columns of its table
    let qualifier: string | null = null;
    if (begin > 0 && text[begin - 1] === '.') {
        let qualifierBegin = begin - 1;
        while (qualifierBegin > 0 && WORD_CHAR.test(text[qualifierBegin - 1])) {
            --qualifierBegin;
        }
        qualifier = text.substring(qualifierBegin, begin - 1).toLowerCase();
    }
    let keys: string[];
    if (qualifier != null) {
        const columns = index.columnsByTable.get(qualifier);
        if (columns == null || columns.has(word.toLowerCase())) {
            return null;
        }
        keys = lookupPrefix(index, word, Number.MAX_SAFE_INTEGER).filter(key => columns.has(key)).slice(0, HINT_MAX_CANDIDATES + 1);
    } else {
        if (word.length < HINT_MIN_PREFIX_LENGTH || !isIdentifierCandidate(word) || lookupIdentifier(index, word) != null) {
            return null;
        }
        keys = lookupPrefix(index, word, HINT_MAX_CANDIDATES + 1);
    }
    if (keys.length === 0 || keys.length > HINT_MAX_CANDIDATES) {
        return null;
    }

    // Prefer the columns of tables that the text already mentions
    const mentionedTables = new Set<string>();
    const wordBegin = line.from + begin;
    for (const match of findIdentifierMatches(index, state.doc.toString())) {
        if (match.to < wordBegin || match.from > cursor) {
            for (const name of match.names) {
                if (name.kind === CatalogNameKind.Table) mentionedTables.add(name.name.toLowerCase());
            }
        }
    }
    const ranked = keys
        .map(key => ({ key, rank: rankCandidate(index, key, mentionedTables) }))
        .sort((l, r) => l.rank - r.rank || l.key.length - r.key.length || (l.key < r.key ? -1 : 1));
    const name = index.byKey.get(ranked[0].key)![0].name;
    const insert = name.substring(word.length);
    return insert.length > 0 ? { cursor, insert } : null;
}

/// The completion hint, recomputed only when the user types
export const NLIdentifierHintField = StateField.define<NLIdentifierHint | null>({
    create: () => null,
    update: (hint, tr) => {
        for (const effect of tr.effects) {
            if (effect.is(NLIdentifierHintDismissEffect)) return null;
        }
        if (tr.docChanged) {
            return tr.isUserEvent('input.type') ? computeNLIdentifierHint(tr.state) : null;
        }
        if (tr.selection != null || tr.startState.field(NLIdentifierIndex) !== tr.state.field(NLIdentifierIndex)) {
            return null;
        }
        return hint;
    },
    provide: field => EditorView.decorations.from(field, hint => hint == null
        ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: new HintWidget(hint.insert), side: 1 }).range(hint.cursor)])),
});

/// The ghost text of a completion hint
class HintWidget extends WidgetType {
    constructor(readonly text: string) { super(); }

    eq(other: HintWidget) {
        return other.text === this.text;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = styles.hint;
        span.textContent = this.text;
        return span;
    }
}

const TableDecoration = Decoration.mark({ class: styles.identifier_table });
const ColumnDecoration = Decoration.mark({ class: styles.identifier_column });

/// Mark the finished words that name catalog objects
function buildHighlights(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const selection = state.selection.main;
    for (const match of findIdentifierMatches(state.field(NLIdentifierIndex), state.doc.toString())) {
        // The word the user is still typing is not finished
        if (selection.empty && selection.head > match.from && selection.head <= match.to) {
            continue;
        }
        builder.add(match.from, match.to, match.kind === CatalogNameKind.Table ? TableDecoration : ColumnDecoration);
    }
    return builder.finish();
}

const NLIdentifierHighlights = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = buildHighlights(view.state);
    }
    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.startState.field(NLIdentifierIndex) !== update.state.field(NLIdentifierIndex)) {
            this.decorations = buildHighlights(update.state);
        }
    }
}, { decorations: plugin => plugin.decorations });

/// Tab accepts the hint
function acceptHint(view: EditorView): boolean {
    const hint = view.state.field(NLIdentifierHintField, false);
    if (hint == null) {
        return false;
    }
    view.dispatch({
        changes: { from: hint.cursor, insert: hint.insert },
        selection: { anchor: hint.cursor + hint.insert.length },
        userEvent: 'input.complete',
    });
    return true;
}

/// Escape drops the hint
function dismissHint(view: EditorView): boolean {
    if (view.state.field(NLIdentifierHintField, false) == null) {
        return false;
    }
    view.dispatch({ effects: NLIdentifierHintDismissEffect.of(null) });
    return true;
}

const KEYBINDINGS: KeyBinding[] = [
    { key: 'Tab', run: acceptHint },
    { key: 'Escape', run: dismissHint },
];

/// Highlights and completes catalog identifiers in natural language text.
/// Requires the NLIdentifierIndex field.
export const NLIdentifierExtensions = [
    NLIdentifierHintField,
    NLIdentifierHighlights,
    Prec.highest(keymap.of(KEYBINDINGS)),
];
