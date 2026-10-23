import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionHealth, type ConnectionState } from '../../connections/connection_state.js';
import { SessionConnectionAttentionContext } from './session_connection_attention.js';
import { ConnectionStatusButton } from './session_workbench_sidebar.js';
import * as styles from './session_workbench_sidebar.module.css';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('Connection status button', () => {
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
    });

    function render(health: ConnectionHealth, options: { usedHere?: boolean; attention?: boolean; onOpenSettings?: (anchor: HTMLButtonElement) => void } = {}) {
        const database = { connectionId: 'main', connectionHealth: health } as ConnectionState;
        act(() => root.render(
            <SessionConnectionAttentionContext.Provider value={{ sessionId: 'session', active: options.attention ?? false, request: vi.fn() }}>
                <ConnectionStatusButton database={database} label="Hyper Local" usedHere={options.usedHere ?? true}
                    onOpenSettings={options.onOpenSettings ?? vi.fn()} />
            </SessionConnectionAttentionContext.Provider>,
        ));
        return container.querySelector<HTMLButtonElement>('button')!;
    }

    it('shows the health without a label and opens the settings on click', () => {
        const onOpenSettings = vi.fn();
        const button = render(ConnectionHealth.NOT_STARTED, { onOpenSettings });
        expect(button.getAttribute('aria-label')).toBe('Hyper Local: Disconnected');
        expect(button.textContent).toBe('');
        expect(button.querySelector('circle')?.getAttribute('fill')).toBe('#6e7781');
        act(() => button.click());
        expect(onOpenSettings).toHaveBeenCalledWith(button);
        expect(render(ConnectionHealth.ONLINE).querySelector('circle')?.getAttribute('fill')).toBe('#1f883d');
        expect(render(ConnectionHealth.FAILED).querySelector('circle')?.getAttribute('fill')).toBe('#cf222e');
        // A connecting connection shows the running indicator instead of the dot
        const connecting = render(ConnectionHealth.CONNECTING);
        expect(connecting.getAttribute('aria-label')).toBe('Hyper Local: Connecting');
        expect(connecting.querySelector('circle[cx="8"]')).toBeNull();
        expect(connecting.querySelector('svg')).not.toBeNull();
    });

    it('pulses only for offline connections of the current session', () => {
        expect(render(ConnectionHealth.NOT_STARTED, { attention: true }).getAttribute('data-connection-attention')).toBe('true');
        expect(render(ConnectionHealth.NOT_STARTED, { attention: false }).getAttribute('data-connection-attention')).toBeNull();
        expect(render(ConnectionHealth.ONLINE, { attention: true }).getAttribute('data-connection-attention')).toBeNull();
        expect(render(ConnectionHealth.NOT_STARTED, { attention: true, usedHere: false }).getAttribute('data-connection-attention')).toBeNull();
    });

    it('uses two finite attention pulses and a static spinner for reduced motion', () => {
        const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules));
        const pulse = rules.find(rule => rule instanceof CSSStyleRule && rule.selectorText === `.${styles.database_status_attention}`) as CSSStyleRule;
        expect(pulse.style.animationIterationCount).toBe('2');
        expect(pulse.style.animationDuration).toBe('0.45s');
        const reduced = rules.find(rule => rule instanceof CSSMediaRule && rule.conditionText === '(prefers-reduced-motion: reduce)'
            && Array.from(rule.cssRules).some(child => child instanceof CSSStyleRule && child.selectorText === `.${styles.database_status_attention}`)) as CSSMediaRule;
        const attention = Array.from(reduced.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === `.${styles.database_status_attention}`) as CSSStyleRule;
        expect(attention.style.animationName).toBe('none');
        expect(attention.style.backgroundColor).not.toBe('');
    });
});
