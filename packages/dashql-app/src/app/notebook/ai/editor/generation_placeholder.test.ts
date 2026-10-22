import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GenerationPlaceholder, setGenerationPlaceholder } from './generation_placeholder.js';

describe('Generation placeholder', () => {
    let view: EditorView;
    beforeEach(() => {
        view = new EditorView({
            state: EditorState.create({ doc: '-- how many rows' }),
            parent: document.body,
        });
    });
    afterEach(() => view.destroy());

    const placeholder = () => view.dom.querySelector('[role="status"][aria-label="Generating SQL"]');

    it('shows one line after the script until it is hidden', () => {
        setGenerationPlaceholder(view, false);
        expect(view.state.field(GenerationPlaceholder, false)).toBeUndefined();
        expect(placeholder()).toBeNull();
        setGenerationPlaceholder(view, true);
        expect(view.dom.querySelectorAll('[role="status"]').length).toBe(1);
        expect(placeholder()?.previousElementSibling?.textContent).toBe('-- how many rows');
        setGenerationPlaceholder(view, false);
        expect(placeholder()).toBeNull();
        setGenerationPlaceholder(view, true);
        expect(view.dom.querySelectorAll('[role="status"]').length).toBe(1);
    });

    it('stays at the end of the document', () => {
        setGenerationPlaceholder(view, true);
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\n-- and per day' } });
        expect(placeholder()?.previousElementSibling?.textContent).toBe('-- and per day');
    });
});
