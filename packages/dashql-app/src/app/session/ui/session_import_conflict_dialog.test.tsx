import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionImportCardDependencies } from './session_import_card.js';
import { SessionImportConflictDialog, type SessionImportConflictDialogProps } from './session_import_conflict_dialog.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', class {
    observe() { }
    unobserve() { }
    disconnect() { }
});

const dependencies: SessionImportCardDependencies = {
    CompactNavBar: () => <></>,
    ParticleFlowBackground: () => null,
};

const DETAILS = {
    sessionName: 'Quarterly pipeline',
    sessionUuid: '4f741f53-d76f-4a6d-b1d8-c22aa85bd449',
    existingDisplayLocation: 'Local sessions / Sales',
    existingIsNative: false,
    folderCount: 2,
    scriptCount: 4,
};

function button(name: string): HTMLButtonElement {
    const result = Array.from(document.querySelectorAll('button')).find(candidate => candidate.textContent === name);
    if (!(result instanceof HTMLButtonElement)) throw new Error(`No button named "${name}"`);
    return result;
}

describe('SessionImportConflictDialog', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onReplace: ReturnType<typeof vi.fn<() => void>>;
    let onCreateNew: ReturnType<typeof vi.fn<() => void>>;
    let onCancel: ReturnType<typeof vi.fn<() => void>>;
    let mounted: boolean;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mounted = true;
        onReplace = vi.fn<() => void>();
        onCreateNew = vi.fn<() => void>();
        onCancel = vi.fn<() => void>();
    });

    afterEach(() => {
        if (mounted) act(() => root.unmount());
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    function render(props: Partial<Extract<SessionImportConflictDialogProps, { mode: 'centered' }>> = {}) {
        act(() => root.render(
            <SessionImportConflictDialog
                mode="centered"
                {...DETAILS}
                busy={false}
                onReplace={onReplace}
                onCreateNew={onCreateNew}
                onCancel={onCancel}
                dependencies={dependencies}
                {...props}
            />,
        ));
    }

    it('renders a page-level conflict card with session details', () => {
        render();

        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.querySelector('h1')?.textContent).toBe('Import Session');
        expect(container.textContent).toContain('different UUID');
        expect(container.textContent).toContain(DETAILS.sessionName);
        expect(container.textContent).toContain(DETAILS.sessionUuid);
        expect(container.textContent).toContain(DETAILS.existingDisplayLocation);
        expect(container.textContent).toContain('4 scripts in 2 folders');
        expect(button('Replace')).toBeInstanceOf(HTMLButtonElement);
        expect(button('Create New')).toBeInstanceOf(HTMLButtonElement);
        expect(document.querySelector('button[aria-label="Close"]')).toBeInstanceOf(HTMLButtonElement);
    });

    it('does not auto-focus an action and invokes each action', () => {
        render();

        expect(document.activeElement).toBe(document.body);
        act(() => button('Replace').click());
        act(() => button('Create New').click());
        act(() => (document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());

        expect(onReplace).toHaveBeenCalledOnce();
        expect(onCreateNew).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('does not behave like a dismissible modal', () => {
        render();

        act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));

        expect(onCancel).not.toHaveBeenCalled();
    });

    it('disables actions while busy', () => {
        render({ busy: true });

        expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
        expect(button('Replace').disabled).toBe(true);
        expect(button('Create New').disabled).toBe(true);
        expect((document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).disabled).toBe(true);

        act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));

        expect(onCancel).not.toHaveBeenCalled();
        expect(onReplace).not.toHaveBeenCalled();
        expect(onCreateNew).not.toHaveBeenCalled();
    });

    it('supports anchored placement and restores explicit return focus', () => {
        const anchor = document.createElement('div');
        const returnFocus = document.createElement('button');
        document.body.append(anchor, returnFocus);
        const anchorRef = { current: anchor };
        const returnFocusRef = { current: returnFocus };

        act(() => root.render(
            <SessionImportConflictDialog
                mode="anchored"
                anchorRef={anchorRef}
                returnFocusRef={returnFocusRef}
                {...DETAILS}
                busy={false}
                onReplace={onReplace}
                onCreateNew={onCreateNew}
                onCancel={onCancel}
                dependencies={dependencies}
            />,
        ));

        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.activeElement).not.toBe(button('Create New'));

        act(() => root.unmount());
        expect(document.activeElement).toBe(returnFocus);
        root = createRoot(container);
        anchor.remove();
        returnFocus.remove();
    });
});
