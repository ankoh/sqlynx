import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

import { groupVerticalTabs, VerticalTabs, VerticalTabVariant, type VerticalTabProps } from './vertical_tabs.js';

function tab(tabId: number, group?: string): VerticalTabProps {
    return { tabId, icon: '', labelShort: `Tab ${tabId}`, group };
}

describe('groupVerticalTabs', () => {
    it('groups consecutive tabs of the same group', () => {
        const tabs = { 0: tab(0, 'a'), 1: tab(1, 'b'), 2: tab(2, 'b'), 3: tab(3, 'c') };
        const groups = groupVerticalTabs([0, 1, 2, 3], tabs);
        expect(groups.map(g => g.map(t => t.tabId))).toEqual([[0], [1, 2], [3]]);
    });

    it('keeps ungrouped tabs in a single group', () => {
        const tabs = { 0: tab(0), 1: tab(1) };
        expect(groupVerticalTabs([0, 1], tabs).map(g => g.map(t => t.tabId))).toEqual([[0, 1]]);
    });
});

describe('VerticalTabs', () => {
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

    it('separates the tab groups with bars', () => {
        const tabs = { 0: tab(0, 'Logs'), 1: tab(1, 'Connections'), 2: tab(2, 'Connections') };
        act(() => root.render(
            <VerticalTabs
                variant={VerticalTabVariant.Stacked}
                tabKeys={[0, 1, 2]}
                tabProps={tabs}
                tabRenderers={{ 0: () => <div />, 1: () => <div />, 2: () => <div /> }}
                selectedTab={0}
                selectTab={() => {}}
            />,
        ));
        const groups = [...container.querySelectorAll<HTMLElement>('[role="group"]')];
        expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Logs', 'Connections']);
        expect(groups.map(g => g.querySelectorAll('[data-tab]').length)).toEqual([1, 2]);
        expect(container.querySelectorAll('[role="separator"]').length).toBe(1);
    });
});
