import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { handleInput, onBackspace, DashQLAutoclosePlugin } from './dashql_autoclose.js';

function createView(doc: string, cursor?: number): EditorView {
    const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor ?? doc.length),
        extensions: [DashQLAutoclosePlugin],
    });
    return new EditorView({ state, parent: document.body });
}

function docAndCursor(view: EditorView): { doc: string; cursor: number } {
    return { doc: view.state.doc.toString(), cursor: view.state.selection.main.head };
}

let view: EditorView;

afterEach(() => {
    view?.destroy();
});

describe('autoclose brackets', () => {
    it('auto-closes ( at end of doc', () => {
        view = createView('select ', 7);
        const handled = handleInput(view, 7, 7, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'select ()', cursor: 8 });
    });

    it('auto-closes [ at end of doc', () => {
        view = createView('arr', 3);
        const handled = handleInput(view, 3, 3, '[');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'arr[]', cursor: 4 });
    });

    it('auto-closes { at end of doc', () => {
        view = createView('fn', 2);
        const handled = handleInput(view, 2, 2, '{');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'fn{}', cursor: 3 });
    });

    it('auto-closes ( before whitespace', () => {
        view = createView('select  from t', 7);
        const handled = handleInput(view, 7, 7, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'select () from t', cursor: 8 });
    });

    it('auto-closes ( before )', () => {
        view = createView('fn()', 3);
        const handled = handleInput(view, 3, 3, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'fn(())', cursor: 4 });
    });

    it.each([
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
    ])('inserts only %s when it balances an unmatched %s', (opener, closer) => {
        view = createView(closer, 0);
        const handled = handleInput(view, 0, 0, opener);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: opener + closer, cursor: 1 });
    });

    it('does not auto-close when an unmatched closer follows whitespace', () => {
        view = createView('select  value)', 7);
        const handled = handleInput(view, 7, 7, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'select ( value)', cursor: 8 });
    });

    it('still auto-closes when the following closer is already matched', () => {
        view = createView('(())', 3);
        const handled = handleInput(view, 3, 3, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '(()())', cursor: 4 });
    });

    it('still auto-closes before an unmatched closer of a different type', () => {
        view = createView(']', 0);
        const handled = handleInput(view, 0, 0, '(');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '()]', cursor: 1 });
    });

    it.each(["select  ')'", 'select  -- )', 'select  /* ) */'])('ignores closers in SQL text: %s', doc => {
        view = createView(doc, 7);
        const handled = handleInput(view, 7, 7, '(');
        expect(handled).toBe(true);
        expect(view.state.doc.sliceString(7, 9)).toBe('()');
    });

    it.each(['select  from t; select )', 'select  /* outer /* nested */ ) */'])(
        'does not balance against unrelated SQL text: %s',
        doc => {
            view = createView(doc, 7);
            const handled = handleInput(view, 7, 7, '(');
            expect(handled).toBe(true);
            expect(view.state.doc.sliceString(7, 9)).toBe('()');
        },
    );

    it('does not auto-close ( before a word char', () => {
        view = createView('abc', 1);
        const handled = handleInput(view, 1, 1, '(');
        expect(handled).toBe(false);
    });
});

describe('autoclose quotes', () => {
    it('auto-closes double quote at end of doc', () => {
        view = createView('select ', 7);
        const handled = handleInput(view, 7, 7, '"');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'select ""', cursor: 8 });
    });

    it('auto-closes single quote at end of doc', () => {
        view = createView('select ', 7);
        const handled = handleInput(view, 7, 7, "'");
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: "select ''", cursor: 8 });
    });

    it('auto-closes backtick at end of doc', () => {
        view = createView('', 0);
        const handled = handleInput(view, 0, 0, '`');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '``', cursor: 1 });
    });

    it('does not auto-close quote after word char', () => {
        view = createView("it", 2);
        const handled = handleInput(view, 2, 2, "'");
        expect(handled).toBe(false);
    });

    it('does not auto-close quote before a word char', () => {
        view = createView('abc', 0);
        const handled = handleInput(view, 0, 0, '"');
        expect(handled).toBe(false);
    });

    it('auto-closes quote before whitespace', () => {
        view = createView('a  b', 2);
        const handled = handleInput(view, 2, 2, '"');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'a "" b', cursor: 3 });
    });
});

describe('overtype', () => {
    it('overtypes ) when at cursor', () => {
        view = createView('fn()', 3);
        const handled = handleInput(view, 3, 3, ')');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'fn()', cursor: 4 });
    });

    it('overtypes ] when at cursor', () => {
        view = createView('a[]', 2);
        const handled = handleInput(view, 2, 2, ']');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'a[]', cursor: 3 });
    });

    it('overtypes } when at cursor', () => {
        view = createView('{}', 1);
        const handled = handleInput(view, 1, 1, '}');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '{}', cursor: 2 });
    });

    it('overtypes matching quote when at cursor', () => {
        view = createView('""', 1);
        const handled = handleInput(view, 1, 1, '"');
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '""', cursor: 2 });
    });

    it.each([')', ']', '}'])('inserts unmatched closer %s without an opener', closer => {
        view = createView('(x)', 1);
        const handled = handleInput(view, 1, 1, closer);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: `(${closer}x)`, cursor: 2 });
    });
});

describe('backspace pair deletion', () => {
    it('deletes () pair on backspace', () => {
        view = createView('fn()', 3);
        const handled = onBackspace(view);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'fn', cursor: 2 });
    });

    it('deletes [] pair on backspace', () => {
        view = createView('a[]', 2);
        const handled = onBackspace(view);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: 'a', cursor: 1 });
    });

    it('deletes {} pair on backspace', () => {
        view = createView('{}', 1);
        const handled = onBackspace(view);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '', cursor: 0 });
    });

    it('deletes "" pair on backspace', () => {
        view = createView('""', 1);
        const handled = onBackspace(view);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '', cursor: 0 });
    });

    it("deletes '' pair on backspace", () => {
        view = createView("''", 1);
        const handled = onBackspace(view);
        expect(handled).toBe(true);
        expect(docAndCursor(view)).toEqual({ doc: '', cursor: 0 });
    });

    it('does not delete mismatched pair', () => {
        view = createView('(]', 1);
        const handled = onBackspace(view);
        expect(handled).toBe(false);
    });

    it('does not handle backspace at position 0', () => {
        view = createView('()', 0);
        const handled = onBackspace(view);
        expect(handled).toBe(false);
    });

    it('does not handle backspace with non-empty selection', () => {
        const state = EditorState.create({
            doc: '()',
            selection: EditorSelection.range(0, 2),
            extensions: [DashQLAutoclosePlugin],
        });
        view = new EditorView({ state, parent: document.body });
        const handled = onBackspace(view);
        expect(handled).toBe(false);
    });
});

describe('multi-char input ignored', () => {
    it('returns false for multi-char insert', () => {
        view = createView('', 0);
        const handled = handleInput(view, 0, 0, 'ab');
        expect(handled).toBe(false);
    });
});
