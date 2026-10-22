import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection, Prec, Transaction } from '@codemirror/state';

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const QUOTES = new Set(['"', "'", '`']);
const CLOSERS = new Set([')', ']', '}']);
const BEFORE_CLOSE = /^[\s)\]};,]?$/;

function delimiterImbalance(text: string): number {
    const openers: string[] = [];
    let unmatchedClosers = 0;
    let quote = '';
    let lineComment = false;
    let blockCommentDepth = 0;

    for (let i = 0; i < text.length; ++i) {
        const char = text[i];
        const next = text[i + 1] ?? '';

        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockCommentDepth > 0) {
            if (char === '/' && next === '*') {
                blockCommentDepth += 1;
                ++i;
            } else if (char === '*' && next === '/') {
                blockCommentDepth -= 1;
                ++i;
            }
            continue;
        }
        if (quote) {
            if (char === quote) {
                if (next === quote) {
                    ++i;
                } else {
                    quote = '';
                }
            }
            continue;
        }
        if (QUOTES.has(char)) {
            quote = char;
            continue;
        }
        if (char === '-' && next === '-') {
            lineComment = true;
            ++i;
            continue;
        }
        if (char === '/' && next === '*') {
            blockCommentDepth = 1;
            ++i;
            continue;
        }
        if (char === ';') {
            openers.length = 0;
            unmatchedClosers = 0;
            continue;
        }
        if (PAIRS[char]) {
            openers.push(char);
        } else if (CLOSERS.has(char)) {
            const opener = openers[openers.length - 1];
            if (opener && PAIRS[opener] === char) {
                openers.pop();
            } else {
                unmatchedClosers += 1;
            }
        }
    }
    return openers.length + unmatchedClosers;
}

export function handleInput(
    view: EditorView,
    from: number,
    to: number,
    insert: string,
    defaultInsert: () => Transaction = () => view.state.update({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
        annotations: Transaction.userEvent.of('input.type'),
    }),
): boolean {
    if (insert.length !== 1) return false;

    // Overtype: user types a closer and the char at cursor matches
    if (CLOSERS.has(insert) || QUOTES.has(insert)) {
        const doc = view.state.doc;
        const atCursor = from < doc.length ? doc.sliceString(from, from + 1) : '';
        if (atCursor === insert && from === to) {
            view.dispatch({
                selection: EditorSelection.cursor(from + 1),
                annotations: Transaction.userEvent.of('input.type'),
            });
            return true;
        }
        if (CLOSERS.has(insert)) {
            view.dispatch(defaultInsert());
            return true;
        }
    }

    // Auto-close quotes
    if (QUOTES.has(insert)) {
        const doc = view.state.doc;
        const before = from > 0 ? doc.sliceString(from - 1, from) : '';
        const after = from < doc.length ? doc.sliceString(to, to + 1) : '';
        // Don't auto-close if preceded by a word char (e.g. contractions like it's)
        if (/\w/.test(before)) return false;
        if (!BEFORE_CLOSE.test(after)) return false;

        view.dispatch({
            changes: { from, to, insert: insert + insert },
            selection: EditorSelection.cursor(from + 1),
            annotations: Transaction.userEvent.of('input.type'),
        });
        return true;
    }

    // Auto-close brackets
    const closer = PAIRS[insert];
    if (!closer) return false;

    const doc = view.state.doc;
    const after = from < doc.length ? doc.sliceString(to, to + 1) : '';
    if (!BEFORE_CLOSE.test(after)) return false;

    const withoutSelection = doc.sliceString(0, from) + doc.sliceString(to);
    const withOpener = doc.sliceString(0, from) + insert + doc.sliceString(to);
    if (delimiterImbalance(withOpener) < delimiterImbalance(withoutSelection)) {
        view.dispatch(defaultInsert());
        return true;
    }

    view.dispatch({
        changes: { from, to, insert: insert + closer },
        selection: EditorSelection.cursor(from + 1),
        annotations: Transaction.userEvent.of('input.type'),
    });
    return true;
}

export function onBackspace(view: EditorView): boolean {
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty || sel.from === 0) return false;

    const doc = state.doc;
    const before = doc.sliceString(sel.from - 1, sel.from);
    const after = sel.from < doc.length ? doc.sliceString(sel.from, sel.from + 1) : '';

    if (PAIRS[before] === after || (QUOTES.has(before) && before === after)) {
        view.dispatch({
            changes: { from: sel.from - 1, to: sel.from + 1 },
            selection: EditorSelection.cursor(sel.from - 1),
            annotations: Transaction.userEvent.of('delete.backward'),
        });
        return true;
    }
    return false;
}

export const DashQLAutoclosePlugin = [
    EditorView.inputHandler.of(handleInput),
    Prec.high(keymap.of([{ key: 'Backspace', run: onBackspace }])),
];
