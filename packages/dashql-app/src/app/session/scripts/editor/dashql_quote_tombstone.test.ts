import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';

import {
    QuoteTombstoneField,
    QuotedTokenFinder,
    QuotedTokenSpan,
    tombstoneBackspace,
    tombstoneForwardDelete,
} from './dashql_quote_tombstone.js';

let view: EditorView;

afterEach(() => {
    view?.destroy();
});

function createView(doc: string, cursor: number): EditorView {
    const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [QuoteTombstoneField],
    });
    return new EditorView({ state, parent: document.body });
}

// Treat every quoted span in the doc as a token. Walks the doc directly;
// matches the scanner's behavior for the inputs we care about.
const fakeFinder: QuotedTokenFinder = (state, quotePos) => {
    const doc = state.doc.toString();
    const ch = doc[quotePos];
    if (ch !== '"' && ch !== "'" && ch !== '`') return null;
    // Find the partner quote of the same kind
    // Look for the nearest other quote of the same character to the left and right
    let left = -1;
    for (let i = quotePos - 1; i >= 0; --i) {
        if (doc[i] === ch) {
            left = i;
            break;
        }
    }
    let right = -1;
    for (let i = quotePos + 1; i < doc.length; ++i) {
        if (doc[i] === ch) {
            right = i;
            break;
        }
    }
    if (left >= 0 && quotePos === left + 1 - 1) {
        // we landed on right-edge of a `""` style token? no — fallthrough
    }
    // Determine span: if cursor is on the leading quote, use [quotePos, right]; else [left, quotePos]
    if (right >= 0) {
        const span: QuotedTokenSpan = { leading: quotePos, trailing: right };
        return span;
    }
    if (left >= 0) {
        return { leading: left, trailing: quotePos };
    }
    return null;
};

function docCursor(view: EditorView): { doc: string; cursor: number } {
    return { doc: view.state.doc.toString(), cursor: view.state.selection.main.head };
}

function tombstone(view: EditorView) {
    return view.state.field(QuoteTombstoneField);
}

describe('quote tombstone — backspace arms', () => {
    it('arms tombstone for trailing double quote, moves cursor left, leaves doc untouched', () => {
        view = createView('"foo"', 5);
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: '"foo"', cursor: 4 });
        expect(tombstone(view)).toEqual({ leading: 0, trailing: 4, char: '"' });
    });

    it('arms tombstone for trailing single quote', () => {
        view = createView("'foo'", 5);
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: "'foo'", cursor: 4 });
        expect(tombstone(view)).toEqual({ leading: 0, trailing: 4, char: "'" });
    });

    it('arms tombstone for trailing backtick', () => {
        view = createView('`foo`', 5);
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: '`foo`', cursor: 4 });
        expect(tombstone(view)).toEqual({ leading: 0, trailing: 4, char: '`' });
    });

    it('does nothing on backspace of non-quote', () => {
        view = createView('foo', 3);
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(false);
        expect(tombstone(view)).toBeNull();
    });
});

describe('quote tombstone — completion via second delete', () => {
    it('two backspaces on "" delete both quotes', () => {
        view = createView('""', 1);
        const armed = tombstoneBackspace(view, fakeFinder);
        expect(armed).toBe(true);
        // Cursor stays at 1 (leading-quote case shouldn't move), tombstone armed
        expect(docCursor(view).cursor).toBe(1);
        expect(tombstone(view)).not.toBeNull();
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: '', cursor: 0 });
        expect(tombstone(view)).toBeNull();
    });

    it('second backspace on "foo" with cursor at end deletes the o, not both quotes', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        // cursor at 4 ("foo|"), tombstone armed. Second backspace targets the o, not a quote.
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(false);
        // tombstone still armed; default backspace would delete the o
        expect(tombstone(view)).not.toBeNull();
    });

    it('backspace targeting leading quote after cursor was moved deletes both', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        // cursor at 4 (just before trailing quote). Move to 1 (just after leading quote).
        view.dispatch({ selection: EditorSelection.cursor(1) });
        // Cursor moved but still in span — tombstone retained.
        expect(tombstone(view)).not.toBeNull();
        const handled = tombstoneBackspace(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: 'foo', cursor: 0 });
        expect(tombstone(view)).toBeNull();
    });
});

describe('quote tombstone — typing keeps tombstone', () => {
    it('typing inside the tombstoned span keeps tombstone alive', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        // cursor at 4, tombstone armed
        view.dispatch({
            changes: { from: 4, to: 4, insert: 'b' },
            selection: EditorSelection.cursor(5),
        });
        expect(docCursor(view)).toEqual({ doc: '"foob"', cursor: 5 });
        expect(tombstone(view)).toEqual({ leading: 0, trailing: 5, char: '"' });
    });

    it('typing remaps trailing position when char inserted before it', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        // tombstone leading=0 trailing=4. Insert at cursor (4) -> trailing should map to 5
        view.dispatch({
            changes: { from: 4, to: 4, insert: 'b' },
            selection: EditorSelection.cursor(5),
        });
        const t = tombstone(view)!;
        expect(t.leading).toBe(0);
        expect(t.trailing).toBe(5);
    });
});

describe('quote tombstone — cursor leaves clears', () => {
    it('moving cursor outside the span clears the tombstone', () => {
        view = createView('"foo" bar', 5);
        tombstoneBackspace(view, fakeFinder);
        expect(tombstone(view)).not.toBeNull();
        view.dispatch({ selection: EditorSelection.cursor(8) });
        expect(tombstone(view)).toBeNull();
    });

    it('clicking before the leading quote clears the tombstone', () => {
        view = createView('x"foo"', 6);
        tombstoneBackspace(view, fakeFinder);
        expect(tombstone(view)).not.toBeNull();
        view.dispatch({ selection: EditorSelection.cursor(0) });
        expect(tombstone(view)).toBeNull();
    });
});

describe('quote tombstone — backspace on non-quote keeps tombstone', () => {
    it('backspacing a non-quote character inside the span retains the tombstone', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        // cursor at 4, tombstone armed. Now manually dispatch a delete of the 'o' before cursor.
        view.dispatch({
            changes: { from: 3, to: 4 },
            selection: EditorSelection.cursor(3),
        });
        expect(docCursor(view).doc).toBe('"fo"');
        expect(tombstone(view)).not.toBeNull();
    });
});

describe('quote tombstone — forward delete', () => {
    it('arms tombstone for leading quote on Delete; second Delete removes both', () => {
        view = createView('"foo"', 0);
        const handled = tombstoneForwardDelete(view, fakeFinder);
        expect(handled).toBe(true);
        expect(docCursor(view)).toEqual({ doc: '"foo"', cursor: 0 });
        expect(tombstone(view)).toEqual({ leading: 0, trailing: 4, char: '"' });
        const handled2 = tombstoneForwardDelete(view, fakeFinder);
        expect(handled2).toBe(true);
        expect(docCursor(view)).toEqual({ doc: 'foo', cursor: 0 });
    });
});

describe('quote tombstone — replacement of token clears it', () => {
    it('replacing the entire token clears the tombstone', () => {
        view = createView('"foo"', 5);
        tombstoneBackspace(view, fakeFinder);
        expect(tombstone(view)).not.toBeNull();
        view.dispatch({
            changes: { from: 0, to: 5, insert: 'foo2' },
            selection: EditorSelection.cursor(4),
        });
        expect(tombstone(view)).toBeNull();
    });
});
