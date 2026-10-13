import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookFeedPage, type NotebookFeedPageDependencies } from './notebook_feed_page.js';
import { NotebookViewMode } from '../../scripts/notebook_commands.js';
import { SegmentedControl } from '../../../../ui/foundations/segmented_control.js';
import { Button } from '../../../../ui/foundations/button.js';
import { ConnectionHealth } from '../../connections/attached_database_state.js';
import { HYPER_CONNECTOR } from '../../connections/connector_info.js';
import { AnchorSide } from '../../../../ui/foundations/anchored_position.js';
import { NotebookConnectionAttentionContext } from '../notebook_connection_attention.js';
import * as styles from './notebook_feed_page.module.css';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const state = {
    feedProps: null as any,
    dashboardsEnabled: false,
    mode: NotebookViewMode.Notebook,
    setMode: vi.fn(),
    dashboardProps: null as any,
    shareProps: null as any,
    exportProps: null as any,
    storageProps: null as any,
    connectionProps: null as any,
    attention: null as any,
    execution: { state: null, busy: false, start: vi.fn(), stop: vi.fn() } as any,
};
const dependencies = {
    NotebookFeed: (props: any) => {
        state.attention = React.useContext(NotebookConnectionAttentionContext);
        state.feedProps = props;
        return null;
    },
    ScriptDetails: () => null,
    NotebookWorkbenchSidebar: () => null,
    NotebookNavigationDrawer: () => null,
    ThreeBarsIcon: () => null,
    IconButton: React.forwardRef((props: any, ref: React.ForwardedRef<HTMLButtonElement>) => <button {...props} ref={ref} />),
    Button,
    NotebookURLShareOverlay: (props: any) => {
        state.shareProps = props;
        return null;
    },
    NotebookFileSaveOverlay: (props: any) => {
        state.exportProps = props;
        return null;
    },
    NotebookStorageOverlay: (props: any) => {
        state.storageProps = props;
        return props.renderAnchor({ onClick: props.onOpen });
    },
    ConnectionSettingsOverlay: (props: any) => { state.connectionProps = props; return null; },
    Dashboard: (props: any) => {
        state.dashboardProps = props;
        return <div data-testid="dashboard" />;
    },
    useNotebookViewMode: () => ({ mode: state.mode, setMode: state.setMode }),
    useAppConfig: () => ({ settings: { enableDashboards: state.dashboardsEnabled } }),
    SegmentedControl,
    useNotebookExecution: () => state.execution,
} as unknown as NotebookFeedPageDependencies;

function scripts() {
    return {
        notebookId: 'notebook',
        notebookMetadata: { originalFileName: 'notebook' },
        scriptFocus: { fileName: '01_alpha.sql' },
        scriptRefs: {
            '01_alpha.sql': { scriptId: 1, fileName: '01_alpha.sql' },
        },
        scripts: {
            1: { scriptKey: 1, fileName: '01_alpha.sql' },
        },
    } as any;
}

describe('NotebookFeedPage', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        state.feedProps = null;
        state.dashboardsEnabled = false;
        state.mode = NotebookViewMode.Notebook;
        state.setMode.mockReset();
        state.dashboardProps = null;
        state.shareProps = null;
        state.exportProps = null;
        state.storageProps = null;
        state.connectionProps = null;
        state.execution = { state: null, busy: false, start: vi.fn(), stop: vi.fn() };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('does not request automatic feed scrolling', () => {
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={scripts()}
                modifyNotebookScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(state.feedProps).not.toHaveProperty('scrollTarget');
    });

    it('starts all scripts only when online and idle', () => {
        const modify = vi.fn();
        const render = (connection: any) => act(() => root.render(<NotebookFeedPage
            notebookScripts={scripts()} modifyNotebookScripts={modify} connection={connection} active dependencies={dependencies} />));
        render(null);
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')?.disabled).toBe(true);
        render({ connectionHealth: ConnectionHealth.ONLINE, queriesActive: new Map() });
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')!.click());
        expect(state.execution.start).toHaveBeenCalledWith(modify);
        render({ connectionHealth: ConnectionHealth.ONLINE, queriesActive: new Map([[1, {}]]) });
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')?.disabled).toBe(true);
    });

    it('shows the main connection before secondary actions and opens settings only on click', () => {
        const render = (connection: any) => act(() => root.render(<NotebookFeedPage notebookScripts={scripts()}
            modifyNotebookScripts={vi.fn()} connection={connection} active dependencies={dependencies} />));
        render({ databaseId: 'main', connectionHealth: ConnectionHealth.NOT_STARTED });
        const connect = container.querySelector<HTMLButtonElement>('[aria-label="Disconnected: main execution database"]')!;
        expect(connect.textContent).toBe('Disconnected');
        expect(connect.querySelector('svg')).not.toBeNull();
        expect(connect.querySelector('circle')?.getAttribute('fill')).toBe('#6e7781');
        expect(connect.compareDocumentPosition(container.querySelector('[aria-label="Share as URL"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(state.connectionProps.isOpen).toBe(false);
        expect(state.connectionProps.databaseId).toBe('main');
        expect(state.connectionProps.side).toBe(AnchorSide.OutsideBottom);
        act(() => connect.click());
        expect(state.connectionProps.isOpen).toBe(true);
        expect(state.connectionProps.onConnected).toBeUndefined();
        render({ databaseId: 'main', connectionHealth: ConnectionHealth.ONLINE,
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } } });
        expect(state.connectionProps.isOpen).toBe(true);
        expect(container.querySelector('[aria-label="Embedded: main execution database (embedded)"]')?.textContent).toBe('Embedded');
        expect(container.querySelector('[aria-label="Embedded: main execution database (embedded)"] circle')?.getAttribute('fill')).toBe('#1f883d');
        act(() => state.connectionProps.onClose());
        expect(state.connectionProps.isOpen).toBe(false);
        render({ databaseId: 'main', connectionHealth: ConnectionHealth.FAILED });
        expect(container.querySelector('[aria-label="Failed: main execution database"]')?.textContent).toBe('Failed');
        expect(container.querySelector('[aria-label="Failed: main execution database"] circle')?.getAttribute('fill')).toBe('#cf222e');
        render({ databaseId: 'main', connectionHealth: ConnectionHealth.CONNECTING });
        expect(container.querySelector('[aria-label="Connecting: main execution database"] svg')).not.toBeNull();
    });

    it('pulses Connect on blocked execution hover and clears on main health or notebook changes', async () => {
        const render = (notebookId: string, health: ConnectionHealth) => act(() => root.render(<NotebookFeedPage
            notebookScripts={{ ...scripts(), notebookId }} modifyNotebookScripts={vi.fn()}
            connection={{ databaseId: 'main', connectionHealth: health } as any} active dependencies={dependencies} />));
        render('notebook', ConnectionHealth.NOT_STARTED);
        const wrapper = container.querySelector('[aria-label="Execute All"]')!.parentElement!;
        expect(wrapper.getAttribute('data-execution-connection-blocked')).toBe('true');
        const request = vi.spyOn(state.attention, 'request');
        act(() => wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
        expect(request).toHaveBeenCalledWith('notebook');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        expect(state.attention.active).toBe(true);
        expect(container.querySelector('[data-connection-attention="true"]')).not.toBeNull();
        expect(state.connectionProps.isOpen).toBe(false);
        render('notebook', ConnectionHealth.CONNECTING);
        expect(container.querySelector('[data-connection-attention="true"]')).toBeNull();
        act(() => state.attention.request('notebook'));
        render('other', ConnectionHealth.CONNECTING);
        expect(container.querySelector('[data-connection-attention="true"]')).toBeNull();
    });

    it('keeps the view switch, connection, and execution controls inside mobile and desktop headers', async () => {
        const frame = document.createElement('iframe');
        frame.style.height = '600px';
        document.body.appendChild(frame);
        const frameDocument = frame.contentDocument!;
        const style = frameDocument.createElement('style');
        style.textContent = Array.from(document.styleSheets)
            .flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join('\n');
        frameDocument.head.appendChild(style);
        frameDocument.body.style.margin = '0';
        const host = frameDocument.createElement('div');
        host.style.height = '600px';
        frameDocument.body.appendChild(host);
        const frameRoot = createRoot(host);
        state.dashboardsEnabled = true;
        try {
            for (const width of [320, 375, 800, 1024, 1440]) {
                frame.style.width = `${width}px`;
                for (const busy of [false, true]) {
                    state.execution = { busy, start: vi.fn(), stop: vi.fn(), state: busy ? {
                        phase: 'running', completedScripts: 123, totalScripts: 456,
                        completedStatements: 123, totalStatements: 456, error: null,
                    } : null };
                    await act(async () => {
                        frameRoot.render(<NotebookFeedPage notebookScripts={scripts()} modifyNotebookScripts={vi.fn()}
                            connection={null} active dependencies={dependencies} />);
                        await new Promise(resolve => setTimeout(resolve, 50));
                    });
                    const header = host.querySelector('header')!;
                    const bounds = header.getBoundingClientRect();
                    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
                    const controls = [host.querySelector('[aria-label="Notebook view"]')!,
                        host.querySelector('[aria-label="Disconnected: main execution database"]')!,
                        host.querySelector(busy ? '[aria-label="Stop notebook execution"]' : '[aria-label="Execute All"]')!];
                    for (const control of controls) {
                        const rect = control.getBoundingClientRect();
                        expect(rect.width).toBeGreaterThan(0);
                        expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
                        expect(rect.right).toBeLessThanOrEqual(bounds.right);
                        expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
                    }
                }
            }
        } finally {
            act(() => frameRoot.unmount());
            frame.remove();
        }
    });

    it('uses two finite attention pulses and a scoped static spinner for reduced motion', () => {
        const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules));
        const pulse = rules.find(rule => rule instanceof CSSStyleRule && rule.selectorText === `.${styles.connection_attention}`) as CSSStyleRule;
        expect(pulse.style.animationIterationCount).toBe('2');
        expect(pulse.style.animationDuration).toBe('0.45s');
        const reduced = rules.find(rule => rule instanceof CSSMediaRule && rule.conditionText === '(prefers-reduced-motion: reduce)'
            && Array.from(rule.cssRules).some(child => child instanceof CSSStyleRule && child.selectorText === `.${styles.connection_spinner} *`)) as CSSMediaRule;
        const spinner = Array.from(reduced.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === `.${styles.connection_spinner} *`) as CSSStyleRule;
        expect(spinner.style.animationName).toBe('none');
        const attention = Array.from(reduced.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === `.${styles.connection_attention}`) as CSSStyleRule;
        expect(attention.style.animationName).toBe('none');
        expect(attention.style.backgroundColor).not.toBe('');
    });

    it('shows compact progress and Stop without a Details control', () => {
        state.execution = { busy: true, start: vi.fn(), stop: vi.fn(), state: {
            phase: 'running', completedScripts: 2, totalScripts: 5, completedStatements: 4, totalStatements: 9,
            activeFileName: '3_customers.sql', activeStatementIndex: 2, activeStatementCount: 3, error: null,
        } };
        const render = () => act(() => root.render(<NotebookFeedPage notebookScripts={scripts()}
            modifyNotebookScripts={vi.fn()} connection={null} active dependencies={dependencies} />));
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('2/5 completed');
        const statusButton = container.querySelector<HTMLButtonElement>('[aria-label="Show notebook execution details"]')!;
        expect(statusButton.textContent).toBe('2/5 completed');
        expect(statusButton.querySelector('svg')).not.toBeNull();
        expect(container.querySelector('details')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show notebook execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Notebook execution details"]')?.textContent).toContain('4/9 statements completed');
        expect(document.querySelector('[role="dialog"][aria-label="Notebook execution details"]')?.textContent).toContain('statement 2/3');
        act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close notebook execution details"]')!.click());
        expect(container.querySelector('[aria-label="Execute All"]')).toBeNull();
        const executeButton = container.querySelector<HTMLButtonElement>('[aria-label="Stop notebook execution"]')!;
        expect(executeButton.disabled).toBe(false);
        act(() => executeButton.click());
        expect(state.execution.stop).toHaveBeenCalledOnce();
        state.execution.state.phase = 'stopping';
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Stopping · 2/5 completed');
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop notebook execution"]')?.disabled).toBe(true);
        expect(container.querySelector('[aria-label="Stop notebook execution"]')).toBe(executeButton);
        state.execution.busy = false;
        state.execution.state.phase = 'failed';
        state.execution.state.error = 'Backend failure';
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('2/5 completed');
        expect(container.querySelector('[aria-label="Stop notebook execution"]')).toBeNull();
        expect(container.querySelector('[aria-label="Execute All"]')).toBe(executeButton);
        expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Backend failure');
        expect(document.querySelector('[role="dialog"][aria-label="Notebook execution details"]')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show notebook execution details"]')!.click());
        const errorDialog = document.querySelector('[role="dialog"][aria-label="Notebook execution details"]');
        expect(errorDialog?.querySelector('header h2')?.textContent).toBe('Execution failed');
        const closeButton = errorDialog?.querySelector<HTMLButtonElement>('header [aria-label="Close notebook execution details"]');
        expect(closeButton?.querySelector('svg')).not.toBeNull();
        expect(closeButton?.textContent).toBe('');
        expect(errorDialog?.textContent).toContain('Backend failure');
        expect(errorDialog?.textContent).toContain('3_customers.sql');
        act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close notebook execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Notebook execution details"]')).toBeNull();
        state.execution.state.phase = 'succeeded';
        state.execution.state.completedScripts = 5;
        state.execution.state.error = null;
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('5/5 succeeded');
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show notebook execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Notebook execution details"]')?.textContent).toContain('5/5 succeeded');
    });

    it('uses one header for the workbench toggle, view switcher, and notebook actions', () => {
        state.dashboardsEnabled = true;
        const notebookScripts = scripts();
        const connection = { databaseId: 'database' } as any;
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={notebookScripts}
                modifyNotebookScripts={vi.fn()}
                connection={connection}
                active
                dependencies={dependencies}
            />,
        ));

        const header = container.querySelector('header')!;
        expect(container.querySelectorAll('header')).toHaveLength(1);
        expect(header.querySelector('[aria-label="Open notebook workbench"]')).not.toBeNull();
        expect(header.querySelector('[aria-label="Notebook view"]')).not.toBeNull();
        for (const label of ['Share as URL', 'Export .dashql', 'Storage']) {
            const button = header.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
            expect(button).not.toBeNull();
            expect(button?.querySelector('svg')?.parentElement?.nextElementSibling?.textContent).toBe(label);
        }

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Share as URL"]')!.click());
        expect(state.shareProps).toMatchObject({ notebookId: 'notebook', isOpen: true });
        expect(state.shareProps.anchorRef.current).toBe(header.querySelector('[aria-label="Share as URL"]'));
        expect(header.querySelector('[aria-label="Share as URL"]')?.getAttribute('aria-expanded')).toBe('true');

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Export .dashql"]')!.click());
        expect(state.exportProps).toMatchObject({ notebookScripts, conn: connection, isOpen: true });
        expect(state.exportProps.anchorRef.current).toBe(header.querySelector('[aria-label="Export .dashql"]'));
        expect(header.querySelector('[aria-label="Export .dashql"]')?.getAttribute('aria-expanded')).toBe('true');

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Storage"]')!.click());
        expect(state.storageProps).toMatchObject({ notebookId: 'notebook', isOpen: true });
    });

    it('keeps the single action header when dashboards are disabled', () => {
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={scripts()}
                modifyNotebookScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelectorAll('header')).toHaveLength(1);
        expect(container.querySelector('header [aria-label="Notebook view"]')).toBeNull();
        expect(container.querySelector('header [aria-label="Storage"]')).not.toBeNull();
    });

    it('hides the Dashboard switch by default', () => {
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={scripts()}
                modifyNotebookScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[aria-label="Notebook view"]')).toBeNull();
        expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();
        expect(state.feedProps.active).toBe(true);
    });

    it('does not render a Dashboard requested while disabled', () => {
        state.mode = NotebookViewMode.Dashboard;
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={scripts()}
                modifyNotebookScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();
        expect(state.feedProps.active).toBe(true);
    });

    it('switches between Notebook and Dashboard from the content view bar when enabled', () => {
        state.dashboardsEnabled = true;
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={scripts()}
                modifyNotebookScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        const buttons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Notebook view"] button');
        expect(buttons[0]?.getAttribute('aria-current')).toBe('true');
        act(() => buttons[1]?.click());
        expect(state.setMode).toHaveBeenCalledWith(NotebookViewMode.Dashboard);
    });

    it('renders the Dashboard beneath the view bar without activating the feed', () => {
        state.dashboardsEnabled = true;
        state.mode = NotebookViewMode.Dashboard;
        const notebookScripts = scripts();
        const modifyNotebookScripts = vi.fn();
        act(() => root.render(
            <NotebookFeedPage
                notebookScripts={notebookScripts}
                modifyNotebookScripts={modifyNotebookScripts}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[data-testid="dashboard"]')).not.toBeNull();
        expect(state.dashboardProps).toMatchObject({ notebookScripts, modifyNotebookScripts });
        expect(state.feedProps.active).toBe(false);
        const buttons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Notebook view"] button');
        expect(buttons[1]?.getAttribute('aria-current')).toBe('true');
        act(() => buttons[0]?.click());
        expect(state.setMode).toHaveBeenCalledWith(NotebookViewMode.Notebook);
    });
});
