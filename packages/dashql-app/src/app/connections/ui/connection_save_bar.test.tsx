import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

import type { ConnectionSaveResult } from '../connection_persistence.js';
import { ConnectionSaveBar, type ConnectionSaveBarProps } from './connection_settings_overlay.js';

const SAVED: ConnectionSaveResult = {
    params: { trino: {} } as ConnectionSaveResult['params'],
    manifest: { status: 'written' },
    sessions: [],
};

describe('ConnectionSaveBar', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
    });

    function render(overrides: Partial<ConnectionSaveBarProps>) {
        const props: ConnectionSaveBarProps = {
            dirty: false,
            saving: false,
            connecting: false,
            online: false,
            sessionCount: 1,
            result: null,
            save: () => {},
            discard: () => {},
            retry: async () => null,
            ...overrides,
        };
        act(() => root.render(<ConnectionSaveBar {...props} />));
    }

    function button(text: string): HTMLButtonElement | undefined {
        return Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);
    }

    it('is hidden without unsaved changes', () => {
        render({});
        expect(container.textContent).toBe('');
    });

    it('offers to save or discard unsaved changes', () => {
        const save = vi.fn();
        const discard = vi.fn();
        render({ dirty: true, sessionCount: 3, save, discard });
        expect(container.textContent).toContain('Unsaved changes');
        expect(container.textContent).toContain('applies to 3 sessions');
        expect(container.textContent).toContain('Connecting saves them too.');
        act(() => button('Save')!.click());
        act(() => button('Discard')!.click());
        expect(save).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledTimes(1);
    });

    it('explains that an open connection keeps its settings until reconnecting', () => {
        render({ dirty: true, online: true });
        expect(container.textContent).toContain('until you reconnect');
        expect(container.textContent).not.toContain('Connecting saves');
    });

    it('disables the actions while connecting', () => {
        render({ dirty: true, connecting: true });
        expect(button('Save')!.disabled).toBe(true);
        expect(button('Discard')!.disabled).toBe(true);
    });

    it('confirms a finished save briefly', () => {
        vi.useFakeTimers();
        render({ dirty: true, saving: true, sessionCount: 2 });
        expect(button('Saving…')!.disabled).toBe(true);
        render({ dirty: false, saving: false, sessionCount: 2, result: SAVED });
        expect(container.textContent).toBe('Saved for 2 sessions');
        act(() => { vi.advanceTimersByTime(3000); });
        expect(container.textContent).toBe('');
    });

    it('does not confirm a save that finished before the bar was shown', () => {
        render({ result: SAVED });
        expect(container.textContent).toBe('');
    });

    it('keeps the draft actions when the manifest could not be written', () => {
        render({ dirty: true, result: { ...SAVED, manifest: { status: 'failed', error: new Error('disk full') } } });
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('could not be saved: disk full');
        expect(button('Save')).toBeDefined();
    });
});
