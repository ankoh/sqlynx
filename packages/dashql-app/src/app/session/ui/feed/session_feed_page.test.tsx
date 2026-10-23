import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionFeedPage, type SessionFeedPageDependencies } from './session_feed_page.js';
import { SessionViewMode } from '../session_view_mode.js';
import { SegmentedControl } from '../../../../ui/foundations/segmented_control.js';
import { Button } from '../../../../ui/foundations/button.js';
import { ConnectionHealth } from '../../../connections/connection_state.js';
import { SessionConnectionAttentionContext } from '../session_connection_attention.js';
import { FlavorProvider } from '../../../flavor/flavor_provider.js';
import { SIDB_FLAVOR } from '../../../flavor/flavors.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const state = {
    feedProps: null as any,
    dashboardsEnabled: false,
    mode: SessionViewMode.Session,
    setMode: vi.fn(),
    dashboardProps: null as any,
    shareProps: null as any,
    exportProps: null as any,
    storageProps: null as any,
    attention: null as any,
    execution: { state: null, busy: false, start: vi.fn(), stop: vi.fn() } as any,
};
const dependencies = {
    SessionFeed: (props: any) => {
        state.attention = React.useContext(SessionConnectionAttentionContext);
        state.feedProps = props;
        return null;
    },
    ScriptDetails: () => null,
    SessionWorkbenchSidebar: () => null,
    ConnectionOverviewPage: () => null,
    SessionNavigationDrawer: () => null,
    ThreeBarsIcon: () => null,
    IconButton: React.forwardRef((props: any, ref: React.ForwardedRef<HTMLButtonElement>) => <button {...props} ref={ref} />),
    Button,
    SessionURLShareOverlay: (props: any) => {
        state.shareProps = props;
        return null;
    },
    SessionFileSaveOverlay: (props: any) => {
        state.exportProps = props;
        return null;
    },
    SessionStorageOverlay: (props: any) => {
        state.storageProps = props;
        return props.renderAnchor({ onClick: props.onOpen });
    },
    Dashboard: (props: any) => {
        state.dashboardProps = props;
        return <div data-testid="dashboard" />;
    },
    useSessionViewMode: () => ({ mode: state.mode, setMode: state.setMode }),
    useAppConfig: () => ({ settings: { experimental_dashboards: state.dashboardsEnabled } }),
    SegmentedControl,
    useSessionExecution: () => state.execution,
} as unknown as SessionFeedPageDependencies;

function scripts() {
    return {
        sessionId: 'session',
        sessionMetadata: { originalFileName: 'session' },
        scriptFocus: { fileName: '01_alpha.sql' },
        scriptRefs: {
            '01_alpha.sql': { scriptId: 1, fileName: '01_alpha.sql' },
        },
        scriptOrder: ['01_alpha.sql'],
        scripts: {
            1: { scriptKey: 1, fileName: '01_alpha.sql' },
        },
    } as any;
}

describe('SessionFeedPage', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        state.feedProps = null;
        state.dashboardsEnabled = false;
        state.mode = SessionViewMode.Session;
        state.setMode.mockReset();
        state.dashboardProps = null;
        state.shareProps = null;
        state.exportProps = null;
        state.storageProps = null;
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
            <SessionFeedPage
                sessionScripts={scripts()}
                modifySessionScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(state.feedProps).not.toHaveProperty('scrollTarget');
    });

    it('starts all scripts only when online and idle', () => {
        const modify = vi.fn();
        const render = (connection: any) => act(() => root.render(<SessionFeedPage
            sessionScripts={scripts()} modifySessionScripts={modify} connection={connection} active dependencies={dependencies} />));
        render(null);
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')?.disabled).toBe(true);
        render({ connectionHealth: ConnectionHealth.ONLINE, queriesActive: new Map() });
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')!.click());
        expect(state.execution.start).toHaveBeenCalledWith(modify);
        render({ connectionHealth: ConnectionHealth.ONLINE, queriesActive: new Map([[1, {}]]) });
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Execute All"]')?.disabled).toBe(true);
    });

    it('requests connection attention on blocked execution hover and clears on main health or session changes', async () => {
        const render = (sessionId: string, health: ConnectionHealth) => act(() => root.render(<SessionFeedPage
            sessionScripts={{ ...scripts(), sessionId }} modifySessionScripts={vi.fn()}
            connection={{ connectionId: 'main', connectionHealth: health } as any} active dependencies={dependencies} />));
        render('session', ConnectionHealth.NOT_STARTED);
        const wrapper = container.querySelector('[aria-label="Execute All"]')!.parentElement!;
        expect(wrapper.getAttribute('data-execution-connection-blocked')).toBe('true');
        const request = vi.spyOn(state.attention, 'request');
        act(() => wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
        expect(request).toHaveBeenCalledWith('session');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        expect(state.attention.active).toBe(true);
        render('session', ConnectionHealth.CONNECTING);
        expect(state.attention.active).toBe(false);
        act(() => state.attention.request('session'));
        render('other', ConnectionHealth.CONNECTING);
        expect(state.attention.active).toBe(false);
    });

    it('keeps the view switch and execution controls inside mobile and desktop headers', async () => {
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
                        frameRoot.render(<SessionFeedPage sessionScripts={scripts()} modifySessionScripts={vi.fn()}
                            connection={null} active dependencies={dependencies} />);
                        await new Promise(resolve => setTimeout(resolve, 50));
                    });
                    const header = host.querySelector('header')!;
                    const bounds = header.getBoundingClientRect();
                    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
                    const controls = [host.querySelector('[aria-label="Session view"]')!,
                        host.querySelector(busy ? '[aria-label="Stop session execution"]' : '[aria-label="Execute All"]')!];
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

    it('shows compact progress and Stop without a Details control', () => {
        state.execution = { busy: true, start: vi.fn(), stop: vi.fn(), state: {
            phase: 'running', completedScripts: 2, totalScripts: 5, completedStatements: 4, totalStatements: 9,
            activeFileName: '3_customers.sql', activeStatementIndex: 2, activeStatementCount: 3, error: null,
        } };
        const render = () => act(() => root.render(<SessionFeedPage sessionScripts={scripts()}
            modifySessionScripts={vi.fn()} connection={null} active dependencies={dependencies} />));
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('2/5 completed');
        const statusButton = container.querySelector<HTMLButtonElement>('[aria-label="Show session execution details"]')!;
        expect(statusButton.textContent).toBe('2/5 completed');
        expect(statusButton.querySelector('svg')).not.toBeNull();
        expect(container.querySelector('details')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show session execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Session execution details"]')?.textContent).toContain('4/9 statements completed');
        expect(document.querySelector('[role="dialog"][aria-label="Session execution details"]')?.textContent).toContain('statement 2/3');
        act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close session execution details"]')!.click());
        expect(container.querySelector('[aria-label="Execute All"]')).toBeNull();
        const executeButton = container.querySelector<HTMLButtonElement>('[aria-label="Stop session execution"]')!;
        expect(executeButton.disabled).toBe(false);
        act(() => executeButton.click());
        expect(state.execution.stop).toHaveBeenCalledOnce();
        state.execution.state.phase = 'stopping';
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Stopping · 2/5 completed');
        expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop session execution"]')?.disabled).toBe(true);
        expect(container.querySelector('[aria-label="Stop session execution"]')).toBe(executeButton);
        state.execution.busy = false;
        state.execution.state.phase = 'failed';
        state.execution.state.error = 'Backend failure';
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('2/5 completed');
        expect(container.querySelector('[aria-label="Stop session execution"]')).toBeNull();
        expect(container.querySelector('[aria-label="Execute All"]')).toBe(executeButton);
        expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Backend failure');
        expect(document.querySelector('[role="dialog"][aria-label="Session execution details"]')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show session execution details"]')!.click());
        const errorDialog = document.querySelector('[role="dialog"][aria-label="Session execution details"]');
        expect(errorDialog?.querySelector('header h2')?.textContent).toBe('Execution failed');
        const closeButton = errorDialog?.querySelector<HTMLButtonElement>('header [aria-label="Close session execution details"]');
        expect(closeButton?.querySelector('svg')).not.toBeNull();
        expect(closeButton?.textContent).toBe('');
        expect(errorDialog?.textContent).toContain('Backend failure');
        expect(errorDialog?.textContent).toContain('3_customers.sql');
        act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close session execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Session execution details"]')).toBeNull();
        state.execution.state.phase = 'succeeded';
        state.execution.state.completedScripts = 5;
        state.execution.state.error = null;
        render();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('5/5 succeeded');
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show session execution details"]')!.click());
        expect(document.querySelector('[role="dialog"][aria-label="Session execution details"]')?.textContent).toContain('5/5 succeeded');
    });

    it('keeps the running status indicator mounted as execution progress changes', () => {
        state.execution = { busy: true, start: vi.fn(), stop: vi.fn(), state: {
            phase: 'running', completedScripts: 1, totalScripts: 5,
            completedStatements: 1, totalStatements: 9, error: null,
        } };
        const render = () => act(() => root.render(<SessionFeedPage sessionScripts={scripts()}
            modifySessionScripts={vi.fn()} connection={null} active dependencies={dependencies} />));
        render();
        const indicator = container.querySelector('[aria-label="Show session execution details"] svg');
        state.execution.state = { ...state.execution.state, completedScripts: 2, completedStatements: 4 };
        render();
        expect(container.querySelector('[aria-label="Show session execution details"] svg')).toBe(indicator);
    });

    it('uses one header for the workbench toggle, view switcher, and session actions', () => {
        state.dashboardsEnabled = true;
        const sessionScripts = scripts();
        const connection = { connectionId: 'database' } as any;
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={sessionScripts}
                modifySessionScripts={vi.fn()}
                connection={connection}
                active
                dependencies={dependencies}
            />,
        ));

        const header = container.querySelector('header')!;
        expect(container.querySelectorAll('header')).toHaveLength(1);
        expect(header.querySelector('[aria-label="Open session workbench"]')).not.toBeNull();
        expect(header.querySelector('[aria-label="Session view"]')).not.toBeNull();
        for (const label of ['Share as URL', 'Export .dashql', 'Storage']) {
            const button = header.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
            expect(button).not.toBeNull();
            expect(button?.querySelector('svg')?.parentElement?.nextElementSibling?.textContent).toBe(label);
        }

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Share as URL"]')!.click());
        expect(state.shareProps).toMatchObject({ sessionId: 'session', isOpen: true });
        expect(state.shareProps.anchorRef.current).toBe(header.querySelector('[aria-label="Share as URL"]'));
        expect(header.querySelector('[aria-label="Share as URL"]')?.getAttribute('aria-expanded')).toBe('true');

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Export .dashql"]')!.click());
        expect(state.exportProps).toMatchObject({ sessionScripts, conn: connection, isOpen: true });
        expect(state.exportProps.anchorRef.current).toBe(header.querySelector('[aria-label="Export .dashql"]'));
        expect(header.querySelector('[aria-label="Export .dashql"]')?.getAttribute('aria-expanded')).toBe('true');

        act(() => header.querySelector<HTMLButtonElement>('[aria-label="Storage"]')!.click());
        expect(state.storageProps).toMatchObject({ sessionId: 'session', isOpen: true });
    });

    it('hides the archive export when the flavor does not support it', () => {
        act(() => root.render(
            <FlavorProvider flavor={SIDB_FLAVOR}>
                <SessionFeedPage
                    sessionScripts={scripts()}
                    modifySessionScripts={vi.fn()}
                    connection={{ connectionId: 'database' } as any}
                    active
                    dependencies={dependencies}
                />
            </FlavorProvider>,
        ));

        const header = container.querySelector('header')!;
        expect(header.querySelector('[aria-label="Share as URL"]')).not.toBeNull();
        expect(header.querySelector('[aria-label="Export .dashql"]')).toBeNull();
        expect(header.querySelector('[aria-label="Storage"]')).not.toBeNull();
    });

    it('keeps the single action header when dashboards are disabled', () => {
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={scripts()}
                modifySessionScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelectorAll('header')).toHaveLength(1);
        expect(container.querySelector('header [aria-label="Session view"]')).toBeNull();
        expect(container.querySelector('header [aria-label="Storage"]')).not.toBeNull();
    });

    it('hides the Dashboard switch by default', () => {
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={scripts()}
                modifySessionScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[aria-label="Session view"]')).toBeNull();
        expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();
        expect(state.feedProps.active).toBe(true);
    });

    it('does not render a Dashboard requested while disabled', () => {
        state.mode = SessionViewMode.Dashboard;
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={scripts()}
                modifySessionScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();
        expect(state.feedProps.active).toBe(true);
    });

    it('switches between Session and Dashboard from the content view bar when enabled', () => {
        state.dashboardsEnabled = true;
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={scripts()}
                modifySessionScripts={vi.fn()}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        const buttons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Session view"] button');
        expect(buttons[0]?.getAttribute('aria-current')).toBe('true');
        act(() => buttons[1]?.click());
        expect(state.setMode).toHaveBeenCalledWith(SessionViewMode.Dashboard);
    });

    it('renders the Dashboard beneath the view bar without activating the feed', () => {
        state.dashboardsEnabled = true;
        state.mode = SessionViewMode.Dashboard;
        const sessionScripts = scripts();
        const modifySessionScripts = vi.fn();
        act(() => root.render(
            <SessionFeedPage
                sessionScripts={sessionScripts}
                modifySessionScripts={modifySessionScripts}
                connection={null}
                active
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[data-testid="dashboard"]')).not.toBeNull();
        expect(state.dashboardProps).toMatchObject({ sessionScripts, modifySessionScripts });
        expect(state.feedProps.active).toBe(false);
        const buttons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Session view"] button');
        expect(buttons[1]?.getAttribute('aria-current')).toBe('true');
        act(() => buttons[0]?.click());
        expect(state.setMode).toHaveBeenCalledWith(SessionViewMode.Session);
    });
});
