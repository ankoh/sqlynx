import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DashQLGenerationPlaceholder, DashQLGenerationPlaceholderEffect } from './dashql_generation_placeholder.js';

describe('Generation placeholder', () => {
    let view: EditorView;
    beforeEach(() => {
        view = new EditorView({
            state: EditorState.create({ doc: '-- how many rows', extensions: [DashQLGenerationPlaceholder] }),
            parent: document.body,
        });
    });
    afterEach(() => view.destroy());

    const placeholder = () => view.dom.querySelector('[role="status"][aria-label="Generating SQL"]');

    it('shows one line after the script until it is hidden', () => {
        expect(placeholder()).toBeNull();
        view.dispatch({ effects: DashQLGenerationPlaceholderEffect.of(true) });
        expect(view.dom.querySelectorAll('[role="status"]').length).toBe(1);
        expect(placeholder()?.previousElementSibling?.textContent).toBe('-- how many rows');
        view.dispatch({ effects: DashQLGenerationPlaceholderEffect.of(false) });
        expect(placeholder()).toBeNull();
    });

    it('stays at the end of the document', () => {
        view.dispatch({ effects: DashQLGenerationPlaceholderEffect.of(true) });
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\n-- and per day' } });
        expect(placeholder()?.previousElementSibling?.textContent).toBe('-- and per day');
    });
});
