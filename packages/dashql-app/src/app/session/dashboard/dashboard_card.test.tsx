import * as React from 'react';
import { DndContext } from '@dnd-kit/core';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScriptData } from '../scripts/session_scripts.js';
import { DashboardCard, type DashboardCardDependencies } from './dashboard_card.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const dependencies = {
    useQueryState: () => ({ queryId: 7 }),
    QueryResultView: () => <div data-testid="output">output</div>,
    VisualizationDispatch: () => <div data-testid="visualization">visualization</div>,
    ScriptEditor: () => <div data-testid="content">content</div>,
} as unknown as DashboardCardDependencies;

const script = {
    scriptKey: 1,
    fileName: '1_sales.sql',
    latestQueryId: 7,
    annotations: {
        visualizeQuery: { renderer: 'vegalite', sql: 'select 1', vegaLiteSpec: {} },
    },
} as ScriptData;

describe('DashboardCard', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root.render(
            <DndContext>
                <DashboardCard
                    sessionId="session"
                    script={script}
                    placement={{ id: 1, row: 0, column: 0, width: 6, height: 3 }}
                    columnStep={100}
                    rowStep={108}
                    onResize={vi.fn()}
                    onResizeCancel={vi.fn()}
                    shifted={false}
                    dependencies={dependencies}
                />
            </DndContext>,
        ));
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('switches between visualization content and query output', () => {
        expect(container.querySelector('[data-testid="visualization"]')).not.toBeNull();
        const content = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Content')!;
        act(() => content.click());
        expect(container.querySelector('[data-testid="content"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="visualization"]')).toBeNull();
    });

    it('uses the query result view for table content', () => {
        const tableScript = {
            ...script,
            annotations: { visualizeQuery: { renderer: 'table', sql: 'select 1' } },
        } as ScriptData;
        act(() => root.render(
            <DndContext>
                <DashboardCard
                    sessionId="session"
                    script={tableScript}
                    placement={{ id: 1, row: 0, column: 0, width: 6, height: 3 }}
                    columnStep={100}
                    rowStep={108}
                    onResize={vi.fn()}
                    onResizeCancel={vi.fn()}
                    shifted={false}
                    dependencies={dependencies}
                />
            </DndContext>,
        ));

        expect(container.querySelector('[data-testid="output"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="content"]')).toBeNull();
    });
});
