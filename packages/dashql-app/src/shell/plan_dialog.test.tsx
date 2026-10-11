import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';

import { EditorView } from '@codemirror/view';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerProvider } from '../platform/logger/logger_provider.js';
import {
    usePlanDialog,
    type PlanDialogController,
    type PlanDialogDependencies,
} from './plan_dialog.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const dependencies: PlanDialogDependencies = {
    createPlanLayoutConfig: () => new dashql.buffers.view.PlanLayoutConfigT(),
    PlanView: props => (
        <div
            aria-label={`Query execution plan with ${props.plan.read().operatorsLength()} operators`}
            data-auto-focus={props.autoFocus}
        />
    ),
};

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

const VALID_PLAN = JSON.stringify({
    operator: 'executiontarget',
    operatorId: 1,
    input: { operator: 'tablescan', operatorId: 2 },
});

let core: dashql.DashQL;
beforeAll(async () => {
    core = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

afterAll(() => core.resetUnsafe());

function editorContent(): HTMLElement {
    const content = document.querySelector('.cm-content');
    if (!(content instanceof HTMLElement)) throw new Error('Plan editor is not mounted');
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

function modeButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(candidate => candidate.textContent === label);
    if (button == null) throw new Error(`No ${label} plan button`);
    return button;
}

describe('query plan dialog', () => {
    let container: HTMLDivElement;
    let root: Root;
    let controller: PlanDialogController;
    let mounted: boolean;
    let fallbackPasteHandler: ((text: string) => void) | null;
    const appEvents = {
        subscribeFallbackPasteEvents: vi.fn((handler: (text: string) => void) => {
            fallbackPasteHandler = handler;
        }),
        unsubscribeFallbackPasteEvents: vi.fn((handler: (text: string) => void) => {
            if (fallbackPasteHandler === handler) fallbackPasteHandler = null;
        }),
    };

    const Harness = () => {
        const planDialog = usePlanDialog(appEvents, dependencies);
        controller = planDialog.controller;
        return (
            <LoggerProvider>
                <div><button type="button">Open plan</button>{planDialog.dialog}</div>
            </LoggerProvider>
        );
    };

    beforeEach(() => {
        fallbackPasteHandler = null;
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mounted = true;
        act(() => root.render(<Harness />));
    });

    afterEach(() => {
        if (mounted) act(() => root.unmount());
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    function open(signal?: AbortSignal): Promise<void> {
        let result!: Promise<void>;
        act(() => { result = controller.request(core, signal); });
        return result;
    }

    it('provides an accessible modal and initially focuses an empty Raw editor', async () => {
        const result = open();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;

        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Query Plan');
        expect(editorContent().getAttribute('aria-label')).toBe('Query plan JSON');
        expect(document.activeElement).toBe(editorContent());
        expect(document.querySelector('.cm-placeholder')).toBeNull();
        expect(modeButton('Viewer').disabled).toBe(true);
        expect(document.querySelector('[role="alert"]')).toBeNull();

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close query plan"]')!.click());
        await expect(result).resolves.toBeUndefined();
    });

    it('renders a valid Hyper plan and restores the exact Raw JSON', async () => {
        const result = open();
        const raw = `  ${VALID_PLAN}\n`;
        await act(async () => {
            setEditorText(raw);
            await Promise.resolve();
        });

        expect(modeButton('Viewer').disabled).toBe(false);
        act(() => modeButton('Viewer').click());
        expect(document.querySelector('[aria-label="Query execution plan with 2 operators"]')?.getAttribute('data-auto-focus')).toBe('true');

        act(() => modeButton('Raw').click());
        expect(editorText()).toBe(raw);

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close query plan"]')!.click());
        await result;
    });

    it('replaces Raw content and opens Viewer after a valid fallback paste', async () => {
        const result = open();
        expect(fallbackPasteHandler).not.toBeNull();

        await act(async () => {
            fallbackPasteHandler?.(`  ${VALID_PLAN}\n`);
            await Promise.resolve();
        });
        expect(document.querySelector('[aria-label="Query execution plan with 2 operators"]')).not.toBeNull();
        expect(modeButton('Viewer').disabled).toBe(false);

        act(() => modeButton('Raw').click());
        expect(editorText()).toBe(`  ${VALID_PLAN}\n`);

        await act(async () => {
            fallbackPasteHandler?.('{not valid');
            await Promise.resolve();
        });
        expect(modeButton('Viewer').disabled).toBe(true);
        expect(editorText()).toBe('{not valid');

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close query plan"]')!.click());
        await result;
        expect(appEvents.unsubscribeFallbackPasteEvents).toHaveBeenCalledOnce();
    });

    it('disables Viewer for malformed and operator-free plans, then recovers', async () => {
        const result = open();
        await act(async () => {
            setEditorText('{not valid');
            await Promise.resolve();
        });
        expect(document.querySelector('[role="alert"]')?.textContent).not.toBe('');
        expect(modeButton('Viewer').disabled).toBe(true);

        await act(async () => {
            setEditorText('{}');
            await Promise.resolve();
        });
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('no operators');
        expect(modeButton('Viewer').disabled).toBe(true);

        await act(async () => {
            setEditorText(VALID_PLAN);
            await Promise.resolve();
        });
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(modeButton('Viewer').disabled).toBe(false);

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close query plan"]')!.click());
        await result;
    });

    it('ignores outside clicks and closes on Escape', async () => {
        const result = open();
        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();

        act(() => document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ));
        await expect(result).resolves.toBeUndefined();
    });

    it('closes and settles when the command is aborted or the component unmounts', async () => {
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
