import * as React from 'react';

import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as dashql from '@ankoh/dashql-core';
import { ResizeObserverMock } from '../../../../../test/view_mocks.js';
import type { PlanScene, PlanSceneOperator } from './plan_scene.js';
import { formatEstimateSymbol, PlanView, type PlanViewDependencies } from './plan_view.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const operators: PlanSceneOperator[] = [
    {
        id: 0,
        typeName: null,
        label: 'Scan orders',
        displayLabel: 'Scan orders',
        rect: { x: 40, y: 40, width: 100, height: 32 },
        ports: 1,
        statistics: {
            inputCardinalityEstimated: 0,
            inputCardinalityConsumed: 0n,
            outputCardinalityEstimated: 10,
            outputCardinalityProduced: 0n,
            hasOutputCardinalityProduced: false,
            memoryBytes: 0n,
        },
        properties: { table: 'orders' },
    },
    {
        id: 1,
        typeName: null,
        label: 'Project total',
        displayLabel: 'Project total',
        rect: { x: 160, y: 40, width: 100, height: 32 },
        ports: 3,
        statistics: {
            inputCardinalityEstimated: 10,
            inputCardinalityConsumed: 0n,
            outputCardinalityEstimated: 10,
            outputCardinalityProduced: 0n,
            hasOutputCardinalityProduced: false,
            memoryBytes: 0n,
        },
        properties: { expression: 'price * quantity' },
    },
    {
        id: 2,
        typeName: null,
        label: 'Return results',
        displayLabel: 'Return results',
        rect: { x: 280, y: 40, width: 100, height: 32 },
        ports: 2,
        statistics: {
            inputCardinalityEstimated: 10,
            inputCardinalityConsumed: 0n,
            outputCardinalityEstimated: 10,
            outputCardinalityProduced: 0n,
            hasOutputCardinalityProduced: false,
            memoryBytes: 0n,
        },
        properties: {},
    },
];

const scene: PlanScene = {
    width: 0,
    height: 0,
    layoutConfig: {
        input: {
            levelHeight: 64,
            nodeHeight: 32,
            nodeMarginHorizontal: 32,
            nodePaddingLeft: 12,
            nodePaddingRight: 12,
            iconWidth: 0,
            iconMarginRight: 0,
            maxLabelChars: 20,
            widthPerLabelChar: 8.5,
            nodeMinWidth: 0,
        },
        maxNodesPerLevel: 2,
    } as unknown as dashql.buffers.view.DerivedPlanLayoutConfigT,
    operators,
    edges: [
        {
            id: 10n,
            childOperator: 0,
            parentOperator: 1,
            outputCardinalityEstimated: 10,
            outputCardinalityProduced: null,
            path: 'M 40 40 L 160 40',
        },
        {
            id: 11n,
            childOperator: 1,
            parentOperator: 2,
            outputCardinalityEstimated: 10,
            outputCardinalityProduced: null,
            path: 'M 160 40 L 280 40',
        },
    ],
    crossEdges: [
        {
            id: 12n,
            sourceOperator: 0,
            targetOperator: 2,
            kind: 'reference',
            properties: {},
            path: 'M 40 40 C 40 0, 280 0, 280 40',
        },
    ],
    fragments: [],
    pipelines: [],
};

const dependencies: PlanViewDependencies = {
    materializePlanScene: () => scene,
};

describe('formatEstimateSymbol', () => {
    it('maps estimate-relative differences to seven ordered bands', () => {
        expect([-1, -0.5, -0.25, -0.05, 0, 0.05, 0.25, 0.5, 2].map(value => formatEstimateSymbol(value)))
            .toEqual(['>>', '>>', '>', '~', '=', '~', '<', '<<', '<<']);
    });

    it('treats absolute differences up to 100 rows as approximate', () => {
        expect(formatEstimateSymbol(2, 100)).toEqual('~');
        expect(formatEstimateSymbol(-1, 100)).toEqual('~');
        expect(formatEstimateSymbol(2, 101)).toEqual('<<');
    });
});

describe('PlanView keyboard navigation', () => {
    let container: HTMLDivElement;
    let root: Root;
    const plan = {} as dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel>;

    beforeEach(() => {
        ResizeObserverMock.reset();
        scene.edges[0].outputCardinalityEstimated = 10;
        scene.edges[0].outputCardinalityProduced = null;
        scene.edges[1].outputCardinalityEstimated = 10;
        scene.edges[1].outputCardinalityProduced = null;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root.render(<PlanView plan={plan} dependencies={dependencies} />));
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    function key(target: Element, value: string) {
        act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
    }

    function highlightedEdgeIds(attribute: string): string[] {
        return [...container.querySelectorAll(`[${attribute}]`)].map(edge => edge.getAttribute(attribute)!);
    }

    function operator(id: number): Element {
        return container.querySelector(`[data-plan-operator-id="${id}"]`)!;
    }

    function edge(id: number): SVGPathElement {
        return container.querySelector<SVGPathElement>(`[data-plan-edge-id="${id}"]`)!;
    }

    function badge(id: number): SVGGElement | null {
        return container.querySelector<SVGGElement>(`[data-plan-edge-badge-id="${id}"]`);
    }

    function renderPlan(edgeRendering?: React.ComponentProps<typeof PlanView>['edgeRendering']) {
        // The tests mutate the shared scene fixture in place, the view memoizes derived edges per scene
        const freshScene: PlanViewDependencies = { materializePlanScene: () => ({ ...scene }) };
        act(() => root.render(<PlanView plan={plan} edgeRendering={edgeRendering} dependencies={freshScene} />));
    }

    function selectAnnotation(label: string) {
        const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)!;
        act(() => button.click());
        return button;
    }

    it('renders estimated rows in Rows mode when actual rows are unavailable', () => {
        expect(badge(10)?.textContent).toEqual('10');
        expect(badge(10)?.getAttribute('aria-label')).toEqual('Estimated rows 10');
        expect(container.querySelector('[aria-label="Plan annotations"]')?.textContent).toEqual('PlainRowsEstimates');
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')).not.toBeNull();
    });

    it('renders actual rows in Rows mode when available', () => {
        scene.edges[0].outputCardinalityProduced = 100;
        scene.edges[1].outputCardinalityProduced = 1;
        renderPlan();

        expect(badge(10)?.getAttribute('transform')).toEqual('translate(100, 40)');
        expect(badge(10)?.textContent).toEqual('100');
        expect(badge(10)?.getAttribute('aria-label')).toEqual('Actual rows 100');
        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).not.toBeNull();
        expect(badge(10)?.getAttribute('data-highlighted')).toBeNull();
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')?.textContent).toContain('Fewer rowsMore rows');
    });

    it('switches between Plain, Rows, and Estimates annotations', () => {
        scene.edges[0].outputCardinalityProduced = 100;
        renderPlan();
        expect(badge(10)).not.toBeNull();
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')).not.toBeNull();

        const plain = selectAnnotation('Plain');

        expect(badge(10)).toBeNull();
        expect(container.querySelector('[aria-label^="Badge color compares"]')).toBeNull();
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')).toBeNull();
        expect(plain.getAttribute('aria-current')).toEqual('true');

        selectAnnotation('Estimates');
        expect(badge(10)).not.toBeNull();
        expect(container.querySelector('[aria-label^="Badge color compares"]')).not.toBeNull();
        expect(container.querySelector('[aria-label^="Badge color compares"]')?.textContent)
            .toContain('UnderestimatedOverestimatedMatched');
        expect(badge(10)?.textContent).toEqual('~');
        expect(badge(10)?.getAttribute('aria-label')).toContain('Actual rows 100, estimated rows 10');
        expect(badge(10)?.getAttribute('aria-label')).toContain('difference >200%');

        selectAnnotation('Rows');
        expect(badge(10)?.textContent).toEqual('100');
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')).not.toBeNull();
    });

    it('uses estimated rows per badge when actual rows are missing', () => {
        scene.edges[0].outputCardinalityEstimated = 100;
        scene.edges[1].outputCardinalityEstimated = 1;
        scene.edges[0].outputCardinalityProduced = 100;
        renderPlan();

        expect(badge(10)?.textContent).toEqual('100');
        expect(badge(10)?.getAttribute('aria-label')).toEqual('Actual rows 100');
        expect(badge(11)?.textContent).toEqual('1');
        expect(badge(11)?.getAttribute('aria-label')).toEqual('Estimated rows 1');
    });

    it('uses the sequential RdPu scale for row counts', () => {
        scene.edges[0].outputCardinalityEstimated = 0;
        scene.edges[1].outputCardinalityEstimated = 100;
        renderPlan();

        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).toEqual('rgb(255, 247, 243)');
        expect(badge(11)?.querySelector('rect')?.getAttribute('fill')).toEqual('rgb(73, 0, 106)');
        expect(container.querySelector('[aria-label^="Badge color encodes row count"]')?.textContent)
            .toContain('Fewer rowsMore rows');
    });

    it('uses the comparison scale for badge fill, adaptive text, and a gray border', () => {
        scene.edges[0].outputCardinalityEstimated = 200;
        scene.edges[0].outputCardinalityProduced = 0;
        scene.edges[1].outputCardinalityEstimated = 0;
        scene.edges[1].outputCardinalityProduced = 200;
        renderPlan();
        selectAnnotation('Estimates');

        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).toEqual('rgb(5, 48, 97)');
        expect(badge(10)?.querySelector('rect')?.getAttribute('stroke')).toEqual('hsl(210, 13%, 74%)');
        expect(badge(10)?.querySelector('text')?.getAttribute('fill')).toEqual('#ffffff');
        expect(badge(11)?.querySelector('rect')?.getAttribute('fill')).toEqual('rgb(103, 0, 31)');
        expect(badge(11)?.querySelector('text')?.getAttribute('fill')).toEqual('#ffffff');
        expect(badge(10)?.textContent).toEqual('>>');
        expect(badge(11)?.textContent).toEqual('<<');

        scene.edges[0].outputCardinalityProduced = 200;
        renderPlan();
        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).toEqual('rgb(242, 239, 238)');
        expect(badge(10)?.querySelector('text')?.getAttribute('fill')).toEqual('#000000');
    });

    it('supports a custom edge color interpolator', () => {
        scene.edges[0].outputCardinalityEstimated = 100;
        scene.edges[0].outputCardinalityProduced = 0;
        scene.edges[1].outputCardinalityEstimated = 0;
        scene.edges[1].outputCardinalityProduced = 100;
        renderPlan({ colorScheme: value => value < 0.5 ? '#000000' : '#ffffff' });
        selectAnnotation('Estimates');

        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).toEqual('#000000');
        expect(badge(11)?.querySelector('rect')?.getAttribute('fill')).toEqual('#ffffff');
        const gradient = container.querySelector<HTMLElement>('[aria-label^="Badge color compares"] i')?.style.backgroundImage;
        expect(gradient).toContain('rgb(0, 0, 0)');
        expect(gradient).toContain('rgb(255, 255, 255)');
    });

    it('paints the selected edge and its badge blue', () => {
        scene.edges[0].outputCardinalityProduced = 100;
        scene.edges[1].outputCardinalityProduced = 10;
        renderPlan();
        const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
        key(viewport, 'ArrowRight');

        const highlight = container.querySelector('[data-plan-edge-highlight-id="10"]')!;
        expect(edge(10).compareDocumentPosition(highlight) & Node.DOCUMENT_POSITION_FOLLOWING).not.toEqual(0);
        expect(Number.parseFloat((highlight as SVGPathElement).style.strokeWidth)).toEqual(2);
        expect(badge(10)?.getAttribute('data-highlighted')).toEqual('true');
        expect(badge(11)?.getAttribute('data-highlighted')).toBeNull();
        expect(badge(10)?.querySelector('rect')?.getAttribute('fill')).toEqual('hsl(211, 100%, 45%)');
        expect(badge(10)?.querySelector('rect')?.getAttribute('stroke')).toEqual('hsl(211, 100%, 45%)');
        expect(badge(10)?.querySelector('text')?.getAttribute('fill')).toEqual('#ffffff');
    });

    it('moves the selected operator with arrow keys instead of panning', () => {
        const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
        key(viewport, 'ArrowRight');
        expect(container.querySelector('[data-plan-operator-id="0"]')?.getAttribute('data-selected')).toEqual('true');
        expect(document.querySelector('[aria-label="Scan orders properties"]')).toBeNull();

        key(container.querySelector('[data-plan-operator-id="0"]')!, 'ArrowRight');
        expect(container.querySelector('[data-plan-operator-id="1"]')?.getAttribute('data-selected')).toEqual('true');
        expect(document.querySelector('[aria-label="Project total properties"]')).toBeNull();
    });

    it('highlights every inbound and outbound edge while navigating with arrow keys', () => {
        const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
        key(viewport, 'ArrowRight');
        expect(highlightedEdgeIds('data-plan-edge-highlight-id')).toEqual(['10']);
        expect(highlightedEdgeIds('data-plan-cross-edge-highlight-id')).toEqual(['12']);
        expect(operator(0).getAttribute('data-highlighted-output-port')).toEqual('true');
        expect(operator(1).getAttribute('data-highlighted-input-port')).toEqual('true');
        expect(operator(2).getAttribute('data-highlighted-input-port')).toEqual('true');

        key(operator(0), 'ArrowRight');
        expect(highlightedEdgeIds('data-plan-edge-highlight-id')).toEqual(['10', '11']);
        expect(highlightedEdgeIds('data-plan-cross-edge-highlight-id')).toEqual([]);
        expect(operator(0).getAttribute('data-highlighted-output-port')).toEqual('true');
        expect(operator(1).getAttribute('data-highlighted-output-port')).toEqual('true');
        expect(operator(1).getAttribute('data-highlighted-input-port')).toEqual('true');
        expect(operator(2).getAttribute('data-highlighted-input-port')).toEqual('true');
    });

    it('highlights every inbound and outbound edge when clicking an operator', () => {
        const operator = container.querySelector('[data-plan-operator-id="2"]')!;
        act(() => operator.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

        expect(operator.getAttribute('data-selected')).toEqual('true');
        expect(highlightedEdgeIds('data-plan-edge-highlight-id')).toEqual(['11']);
        expect(highlightedEdgeIds('data-plan-cross-edge-highlight-id')).toEqual(['12']);
        expect(container.querySelector('[data-plan-operator-id="0"]')?.getAttribute('data-highlighted-output-port')).toEqual('true');
        expect(container.querySelector('[data-plan-operator-id="1"]')?.getAttribute('data-highlighted-output-port')).toEqual('true');
        expect(operator.getAttribute('data-highlighted-input-port')).toEqual('true');
    });

    it('focuses the plan viewport on mount when requested', () => {
        act(() => root.render(
            <PlanView plan={plan} autoFocus dependencies={dependencies} />,
        ));

        expect(document.activeElement).toBe(container.querySelector('[role="region"]'));
    });

    it('toggles the selected operator properties with Enter', () => {
        const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
        key(viewport, 'ArrowRight');
        const selected = container.querySelector('[data-plan-operator-id="0"]')!;

        key(selected, 'Enter');
        expect(document.querySelector('[aria-label="Scan orders properties"]')).not.toBeNull();
        expect(selected.getAttribute('aria-expanded')).toEqual('true');

        key(selected, 'Enter');
        expect(document.querySelector('[aria-label="Scan orders properties"]')).toBeNull();
        expect(selected.getAttribute('aria-expanded')).toEqual('false');
    });

    it('opens operator properties immediately when clicked', () => {
        const node = container.querySelector('[data-plan-operator-id="1"]')!;
        act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));

        expect(node.getAttribute('data-selected')).toEqual('true');
        expect(node.getAttribute('aria-expanded')).toEqual('true');
        expect(document.querySelector('[aria-label="Project total properties"]')).not.toBeNull();
    });

    it('shows the next operator properties when arrow navigation continues with details open', () => {
        const first = container.querySelector('[data-plan-operator-id="0"]')!;
        act(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
        expect(document.querySelector('[aria-label="Scan orders properties"]')).not.toBeNull();

        key(first, 'ArrowRight');

        expect(container.querySelector('[data-plan-operator-id="1"]')?.getAttribute('data-selected')).toEqual('true');
        expect(document.querySelector('[aria-label="Scan orders properties"]')).toBeNull();
        expect(document.querySelector('[aria-label="Project total properties"]')).not.toBeNull();
    });

    it('closes only the operator properties on Escape', () => {
        const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
        key(viewport, 'ArrowRight');
        const selected = container.querySelector('[data-plan-operator-id="0"]')!;
        key(selected, 'Enter');
        expect(document.querySelector('[aria-label="Scan orders properties"]')).not.toBeNull();

        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => selected.dispatchEvent(escape));

        expect(document.querySelector('[aria-label="Scan orders properties"]')).toBeNull();
        expect(escape.defaultPrevented).toEqual(true);
        expect(container.querySelector('[role="region"]')).not.toBeNull();
    });

    it('renders occupied CSS ports on the card boundary', () => {
        const first = container.querySelector('[data-plan-operator-id="0"]')!;
        const second = container.querySelector('[data-plan-operator-id="1"]')!;

        expect(first.querySelector('[data-plan-operator-frame]')).not.toBeNull();
        expect(first.querySelector('[data-plan-port="output"]')?.getAttribute('aria-hidden')).toEqual('true');
        expect(first.querySelector('[data-plan-port="input"]')).toBeNull();
        expect(second.querySelector('[data-plan-port="input"]')?.getAttribute('aria-hidden')).toEqual('true');
        expect(second.querySelector('[data-plan-port="output"]')?.getAttribute('aria-hidden')).toEqual('true');
    });
});
