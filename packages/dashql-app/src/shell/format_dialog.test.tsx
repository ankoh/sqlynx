import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';

import { act } from '@dashql/browser-test-act';
import { EditorView } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerProvider } from '../platform/logger/logger_provider.js';
import { AppConfigProvider, useAppConfig, useAppReconfigure } from '../app/config/app_config.js';
import { useFormatDialog, type FormatDialogController } from './format_dialog.js';

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
    const content = editorContent();
    const view = EditorView.findFromDOM(content);
    if (view == null) throw new Error('CodeMirror view is unavailable');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

function editorText(): string {
    return EditorView.findFromDOM(editorContent())?.state.doc.toString() ?? '';
}

function modeButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(candidate => candidate.textContent === label);
    if (button == null) throw new Error(`No ${label} format button`);
    return button;
}

describe('SQL formatter dialog', () => {
    let container: HTMLDivElement;
    let root: Root;
    let catalog: dashql.DashQLCatalog;
    let controller: FormatDialogController;
    let mounted: boolean;
    let setKeywordCase: (value: 'lower' | 'upper') => void;
    let settingsReady = false;

    const Harness = () => {
        const formatDialog = useFormatDialog();
        const reconfigure = useAppReconfigure();
        settingsReady = useAppConfig() != null;
        setKeywordCase = value => reconfigure(config => config == null ? null : {
            ...config, settings: { ...config.settings, keywordCase: value },
        });
        controller = formatDialog.controller;
        return (
            <LoggerProvider>
                <div><button type="button">Open formatter</button>{formatDialog.dialog}</div>
            </LoggerProvider>
        );
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        catalog = core.createCatalog();
        mounted = true;
        act(() => root.render(<LoggerProvider><AppConfigProvider><Harness /></AppConfigProvider></LoggerProvider>));
    });

    afterEach(() => {
        if (mounted) act(() => root.unmount());
        catalog.destroy();
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    function open(signal?: AbortSignal): Promise<void> {
        let result!: Promise<void>;
        act(() => { result = controller.request(core, catalog, signal); });
        return result;
    }

    it('provides an accessible modal and initially focuses the editable Raw editor', async () => {
        const result = open();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;

        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('SQL Formatter');
        expect(editorContent().getAttribute('aria-label')).toBe('SQL formatter editor');
        expect(editorContent().getAttribute('aria-readonly')).toBe('false');
        expect(document.activeElement).toBe(editorContent());
        expect(document.querySelector('.cm-placeholder')).toBeNull();

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close SQL formatter"]')!.click());
        await expect(result).resolves.toBeUndefined();
    });

    it('shows Compact and Pretty as immutable reversible views', async () => {
        const result = open();
        const raw = 'select count(*) from items where value > 1';
        act(() => setEditorText(raw));

        act(() => modeButton('Compact').click());
        expect(editorText()).toBe('select count(*) from items where value > 1;');
        expect(editorContent().getAttribute('contenteditable')).toBe('false');
        expect(editorContent().getAttribute('aria-readonly')).toBe('true');

        act(() => modeButton('Pretty').click());
        expect(editorText()).toBe('select count(*)\nfrom items\nwhere value > 1;');
        expect(editorContent().getAttribute('contenteditable')).toBe('false');

        act(() => modeButton('Raw').click());
        expect(editorText()).toBe(raw);
        expect(editorContent().getAttribute('contenteditable')).toBe('true');
        expect(editorContent().getAttribute('aria-readonly')).toBe('false');

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close SQL formatter"]')!.click());
        await result;
    });

    it('refreshes an open formatted view when keyword case changes', async () => {
        await vi.waitFor(() => expect(settingsReady).toBe(true));
        const result = open();
        act(() => setEditorText('select count(*) from items'));
        act(() => modeButton('Pretty').click());
        expect(editorText()).toContain('select count(*)');
        act(() => setKeywordCase('upper'));
        expect(editorText()).toContain('SELECT count(*)');
        expect(editorText()).toContain('FROM items');
        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close SQL formatter"]')!.click());
        await result;
    });

    it('disables formatted views for invalid SQL and re-enables them after correction', async () => {
        const result = open();
        await act(async () => {
            setEditorText('select * from foo group');
            await Promise.resolve();
        });

        expect(document.querySelector('[role="alert"]')?.textContent).not.toBe('');
        expect(modeButton('Compact').disabled).toBe(true);
        expect(modeButton('Pretty').disabled).toBe(true);

        await act(async () => {
            setEditorText('select 1');
            await Promise.resolve();
        });
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(modeButton('Compact').disabled).toBe(false);
        expect(modeButton('Pretty').disabled).toBe(false);

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close SQL formatter"]')!.click());
        await result;
    });

    it('keeps empty input valid and ignores outside clicks', async () => {
        const result = open();
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(modeButton('Compact').disabled).toBe(false);
        expect(modeButton('Pretty').disabled).toBe(false);

        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();

        act(() => document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ));
        await expect(result).resolves.toBeUndefined();
    });

    it('opens shared editor search and closes search before the dialog on Escape', async () => {
        const result = open();
        act(() => setEditorText('select one\nselect two'));

        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
        act(() => editorContent().dispatchEvent(new KeyboardEvent('keydown', {
            key: 'f',
            code: 'KeyF',
            bubbles: true,
            cancelable: true,
            metaKey: isMac,
            ctrlKey: !isMac,
        })));

        const searchInput = document.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
        expect(searchInput).not.toBeNull();
        searchInput!.focus();

        act(() => searchInput!.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })));
        expect(document.querySelector('.cm-search')).toBeNull();
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();

        act(() => editorContent().dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })));
        await expect(result).resolves.toBeUndefined();
    });

    it('closes and settles when the shell command is aborted or the component unmounts', async () => {
        const abort = new AbortController();
        const aborted = open(abort.signal);
        act(() => abort.abort());
        await expect(aborted).resolves.toBeUndefined();
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        const unmounted = open();
        act(() => root.unmount());
        mounted = false;
        await expect(unmounted).resolves.toBeUndefined();
    });
});
