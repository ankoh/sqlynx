import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';

import { NotebookComposer, NotebookComposerVariant } from './notebook_composer.js';
import { ComposerInputMode } from './composer_input_mode.js';
import { LoggerProvider } from '../../../../platform/logger/logger_provider.js';
import { DashQLCompletionStartEffect, DashQLProcessorPlugin } from '../../scripts/editor/dashql_processor.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

let dql: core.DashQL;
beforeAll(async () => { dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }); });

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
}

function type(view: EditorView, text: string) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } });
}

describe('Notebook composer', () => {
    let container: HTMLDivElement;
    let root: Root;
    let catalog: core.DashQLCatalog;
    let view: EditorView | null;
    let onSend: ReturnType<typeof vi.fn<(text: string, mode: ComposerInputMode) => void>>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        catalog = dql.createCatalog();
        view = null;
        onSend = vi.fn<(text: string, mode: ComposerInputMode) => void>();
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        catalog.destroy();
        dql.resetUnsafe();
    });

    // The view is created by a chain of effects, wait until the composer hands it out
    async function render(variant = NotebookComposerVariant.Docked, aiAvailable = false) {
        act(() => root.render(<LoggerProvider>
            <NotebookComposer instance={dql} catalog={catalog} variant={variant} aiAvailable={aiAvailable}
                keywordCase={core.buffers.formatting.KeywordCase.LOWER} onSend={onSend} setView={v => { view = v; }} />
        </LoggerProvider>));
        await vi.waitFor(() => expect(view).not.toBeNull());
        return view!;
    }
    const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Run query"]')!;

    it('sends the draft on Enter and clears it', async () => {
        const editor = await render();
        expect(sendButton().disabled).toBe(true);
        act(() => type(editor, 'select 1'));
        expect(sendButton().disabled).toBe(false);
        act(() => press(editor, 'Enter'));
        expect(onSend).toHaveBeenCalledExactlyOnceWith('select 1', ComposerInputMode.Sql);
        expect(editor.state.doc.toString()).toBe('');
        expect(sendButton().disabled).toBe(true);
    });

    it('drops an open completion together with the sent draft', async () => {
        const editor = await render();
        act(() => type(editor, 'select 1 fr'));
        act(() => editor.dispatch({ effects: DashQLCompletionStartEffect.of(null) }));
        expect(editor.state.field(DashQLProcessorPlugin).scriptCompletion).not.toBeNull();
        act(() => press(editor, 'Enter'));
        expect(onSend).toHaveBeenCalledExactlyOnceWith('select 1 fr', ComposerInputMode.Sql);
        expect(editor.state.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('shows the placeholder instead of a completion hint when focused empty', async () => {
        const editor = await render();
        act(() => editor.focus());
        expect(editor.state.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
        expect(container.querySelector('.cm-placeholder')).not.toBeNull();
    });

    it('inserts a newline on Shift+Enter without sending', async () => {
        const editor = await render();
        act(() => type(editor, 'select 1'));
        act(() => press(editor, 'Enter', { shiftKey: true }));
        expect(onSend).not.toHaveBeenCalled();
        expect(editor.state.doc.toString()).toBe('select 1\n');
    });

    it('scrolls long lines without showing a scrollbar', async () => {
        const editor = await render();
        expect(editor.lineWrapping).toBe(false);
        expect(getComputedStyle(editor.scrollDOM).scrollbarWidth).toBe('none');
    });

    it('ignores blank drafts and sends through the button', async () => {
        const editor = await render();
        act(() => type(editor, '  '));
        act(() => press(editor, 'Enter'));
        expect(onSend).not.toHaveBeenCalled();
        act(() => type(editor, 'select 2'));
        act(() => sendButton().click());
        expect(onSend).toHaveBeenCalledExactlyOnceWith('  select 2', ComposerInputMode.Sql);
        expect(editor.state.doc.toString()).toBe('');
    });

    it('keeps the draft across hero and docked variants and disables AI without a provider', async () => {
        const editor = await render(NotebookComposerVariant.Hero);
        expect(container.querySelector('[data-variant="hero"]')).not.toBeNull();
        act(() => type(editor, 'select 3'));
        expect(await render(NotebookComposerVariant.Docked)).toBe(editor);
        expect(container.querySelector('[data-variant="docked"]')).not.toBeNull();
        expect(editor.state.doc.toString()).toBe('select 3');
        const ai = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('AI'));
        expect(ai?.disabled).toBe(true);
    });

    describe('with an AI provider', () => {
        const modeButton = (label: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(label))!;
        const selectedMode = () => container.querySelector('[data-selected] button')?.textContent;
        const typeUser = (editor: EditorView, text: string) => editor.dispatch({
            changes: { from: editor.state.doc.length, insert: text },
            selection: { anchor: editor.state.doc.length + text.length },
            userEvent: 'input.type',
        });

        it('starts in natural language without SQL completion', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            expect(selectedMode()).toContain('AI');
            expect(modeButton('AI').disabled).toBe(false);
            expect(container.querySelector('.cm-placeholder')?.textContent).toBe('Ask a question about your data');
            act(() => typeUser(editor, 'selec'));
            expect(editor.state.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
        });

        it('switches to SQL once the draft is convincingly SQL and back for natural language', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            act(() => type(editor, 'select'));
            expect(selectedMode()).toContain('AI');
            act(() => type(editor, ' 1 '));
            expect(selectedMode()).toContain('SQL');
            act(() => type(editor, 'the revenue of all customers '));
            expect(selectedMode()).toContain('AI');
        });

        it('hesitates to leave SQL for a short invalid tail', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            act(() => type(editor, 'select a, b from orders where x = 1 '));
            expect(selectedMode()).toContain('SQL');
            act(() => type(editor, 'oops '));
            expect(selectedMode()).toContain('SQL');
        });

        it('keeps a mode the user picked until the draft is cleared', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            act(() => modeButton('SQL').click());
            act(() => type(editor, 'what is the revenue of all customers '));
            expect(selectedMode()).toContain('SQL');
            act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } }));
            expect(selectedMode()).toContain('AI');
        });

        it('sends a complete statement as SQL even while its last token is being typed', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            act(() => type(editor, 'select 1'));
            expect(selectedMode()).toContain('AI');
            act(() => press(editor, 'Enter'));
            expect(onSend).toHaveBeenCalledExactlyOnceWith('select 1', ComposerInputMode.Sql);
            expect(editor.state.doc.toString()).toBe('');
        });

        it('sends a question and clears it right away', async () => {
            const editor = await render(NotebookComposerVariant.Docked, true);
            act(() => type(editor, 'what is the revenue'));
            expect(container.querySelector('[aria-label="Ask AI"]')).not.toBeNull();
            act(() => press(editor, 'Enter'));
            expect(onSend).toHaveBeenCalledExactlyOnceWith('what is the revenue', ComposerInputMode.Ai);
            expect(editor.state.doc.toString()).toBe('');
            expect(selectedMode()).toContain('AI');
        });
    });
});
