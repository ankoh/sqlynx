import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookFeedPage, type NotebookFeedPageDependencies } from './notebook_feed_page.js';
import { NotebookViewMode } from '../../scripts/notebook_commands.js';
import { SegmentedControl } from '../../../../ui/foundations/segmented_control.js';
import { Button } from '../../../../ui/foundations/button.js';
import { ConnectionHealth } from '../../connections/attached_database_state.js';

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
    execution: { state: null, busy: false, start: vi.fn(), stop: vi.fn() } as any,
};
const dependencies = {
    NotebookFeed: (props: any) => {
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
