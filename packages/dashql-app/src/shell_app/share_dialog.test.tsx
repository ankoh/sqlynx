import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';

import { act } from '@dashql/browser-test-act';
import { EditorView } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerProvider } from '../platform/logger/logger_provider.js';
import { useShareDialog, type ShareDialogController } from './share_dialog.js';
import { decodeShareScript, SHARE_SCRIPT_HASH_PARAMETER } from './shell_share.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let core: dashql.DashQL;
beforeAll(async () => {
    core = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

afterAll(() => core.resetUnsafe());

function editorContent(): HTMLElement {
    const content = document.querySelector('.cm-content');
    if (!(content instanceof HTMLElement)) throw new Error('SQL editor is not mounted');
    return content;
}

function setEditorText(text: string) {
    const view = EditorView.findFromDOM(editorContent());
    if (view == null) throw new Error('CodeMirror view is unavailable');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

function editorText(): string {
    return EditorView.findFromDOM(editorContent())?.state.doc.toString() ?? '';
}

function shownUrl(): string {
    return document.querySelector('[role="dialog"] output')?.textContent ?? '';
}

function shownLength(): string {
    return document.querySelector('[aria-label="URL length"]')?.textContent ?? '';
}

function copyButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('button[aria-label="Copy share URL"]')!;
}

async function waitForUpdate() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
    });
}

describe('Share dialog', () => {
    let container: HTMLDivElement;
    let root: Root;
    let catalog: dashql.DashQLCatalog;
    let controller: ShareDialogController;

    const Harness = () => {
        const shareDialog = useShareDialog();
        controller = shareDialog.controller;
        return <div>{shareDialog.dialog}</div>;
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        catalog = core.createCatalog();
        act(() => root.render(<LoggerProvider><Harness /></LoggerProvider>));
    });

    afterEach(() => {
        act(() => root.unmount());
        catalog.destroy();
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    function open(signal?: AbortSignal): Promise<void> {
        let result!: Promise<void>;
        act(() => { result = controller.request(core, catalog, signal); });
        return result;
    }

    function close() {
        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close share dialog"]')!.click());
    }

    it('provides an accessible modal that focuses the editor', async () => {
        const result = open();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;

        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Share Script');
        expect(document.activeElement).toBe(editorContent());
        expect(shownUrl()).toBe('Enter SQL to generate a link');
        expect(shownLength()).toBe('0 characters');
        expect(copyButton().disabled).toBe(true);

        close();
        await expect(result).resolves.toBeUndefined();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('encodes the script into the URL once typing pauses', async () => {
        const result = open();
        const script = 'select 1;\n.output table\nselect \'ü\';';
        act(() => setEditorText(script));
        expect(shownLength()).toBe('0 characters');

        await waitForUpdate();
        const url = new URL(shownUrl());
        expect(url.origin).toBe(window.location.origin);
        expect(url.pathname).toBe(window.location.pathname);
        expect(shownLength()).toBe(`${shownUrl().length} characters`);
        expect(copyButton().disabled).toBe(false);
        const payload = new URLSearchParams(url.hash.slice(1)).get(SHARE_SCRIPT_HASH_PARAMETER)!;
        await expect(decodeShareScript(payload)).resolves.toBe(script);

        act(() => setEditorText(''));
        await waitForUpdate();
        expect(shownUrl()).toBe('Enter SQL to generate a link');
        expect(copyButton().disabled).toBe(true);

        close();
        await result;
    });

    it('restores the last script when reopened', async () => {
        let result = open();
        act(() => setEditorText('select 42;'));
        await waitForUpdate();
        const url = shownUrl();
        close();
        await result;

        result = open();
        expect(editorText()).toBe('select 42;');
        await waitForUpdate();
        expect(shownUrl()).toBe(url);
        close();
        await result;
    });

    it('closes on abort and rejects concurrent requests', async () => {
        const abort = new AbortController();
        const result = open(abort.signal);
        await expect(controller.request(core, catalog)).rejects.toThrow('already pending');

        act(() => abort.abort());
        await expect(result).resolves.toBeUndefined();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});
