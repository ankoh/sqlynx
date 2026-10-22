import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

import { NameRow } from './session_storage_overlay.js';

function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('NameRow', () => {
    let container: HTMLDivElement;
    let root: Root;
    const commitName = vi.fn();
    const parentKeyDown = vi.fn();
    const parentPointerDown = vi.fn();

    beforeEach(() => {
        commitName.mockReset();
        parentKeyDown.mockReset();
        parentPointerDown.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root.render(
            <div onKeyDown={parentKeyDown} onPointerDown={parentPointerDown}>
                <NameRow name="Original name" onCommit={commitName} />
            </div>,
        ));
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function nameInput(): HTMLInputElement {
        return container.querySelector('[aria-label="Session name"]') as HTMLInputElement;
    }

    it('does not rename while typing and commits when the input is dismissed', () => {
        const input = nameInput();
        act(() => {
            input.focus();
            setInputValue(input, 'Updated name');
        });

        expect(commitName).not.toHaveBeenCalled();

        act(() => input.blur());
        expect(commitName).toHaveBeenCalledOnce();
        expect(commitName).toHaveBeenCalledWith('Updated name');
    });

    it('commits on Enter', () => {
        const input = nameInput();
        act(() => {
            input.focus();
            setInputValue(input, 'Updated name');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        expect(commitName).toHaveBeenCalledOnce();
        expect(commitName).toHaveBeenCalledWith('Updated name');
    });

    it('keeps text-entry keys inside the name input', () => {
        const input = nameInput();

        act(() => {
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        });

        expect(parentKeyDown).not.toHaveBeenCalled();
    });

    it('keeps text-selection gestures from activating a parent drag sensor', () => {
        const input = nameInput();

        act(() => {
            input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        });

        expect(parentPointerDown).not.toHaveBeenCalled();
    });

    it('cancels on Escape without renaming', () => {
        const input = nameInput();
        act(() => {
            input.focus();
            setInputValue(input, 'Updated name');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        expect(input.value).toBe('Original name');
        expect(commitName).not.toHaveBeenCalled();
    });
});
