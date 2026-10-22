import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d3 from 'd3';

import { SettledBrushUpdates } from './histogram_cell.js';
import { useHistogramBrush } from './histogram_brush.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('SettledBrushUpdates', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces continuous brush updates to the latest selection', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const updates = new SettledBrushUpdates<number>();

        updates.schedule(1, callback);
        vi.advanceTimersByTime(100);
        updates.schedule(2, callback);
        vi.advanceTimersByTime(100);

        expect(callback).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(2);
    });

    it('flushes the final brush selection immediately', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const updates = new SettledBrushUpdates<number>();

        updates.schedule(1, callback);
        updates.flush(2, callback);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(2);
        vi.runAllTimers();
        expect(callback).toHaveBeenCalledOnce();
    });

    it('drops pending work when cancelled', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const updates = new SettledBrushUpdates<number>();

        updates.schedule(1, callback);
        updates.cancel();
        vi.runAllTimers();

        expect(callback).not.toHaveBeenCalled();
    });
});

describe('useHistogramBrush', () => {
    it('clears the rendered brush when the controlled selection is cleared', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const onBrushUpdate = vi.fn();
        const xScale = d3.scaleBand<string>().range([0, 100]).domain(['0', '1']);

        function Brush({ selection }: { selection: [number, number] | null }) {
            const { brushContainer } = useHistogramBrush({
                xScale,
                height: 20,
                selection,
                onBrushUpdate,
                onClear: vi.fn(),
            });
            return React.createElement('svg', null, React.createElement('g', { ref: brushContainer }));
        }

        act(() => root.render(React.createElement(Brush, { selection: [10, 30] })));
        const brushGroup = container.querySelector<SVGGElement>('g')!;
        expect(d3.brushSelection(brushGroup)).toEqual([10, 30]);

        act(() => root.render(React.createElement(Brush, { selection: null })));
        expect(d3.brushSelection(brushGroup)).toBeNull();
        expect(onBrushUpdate).not.toHaveBeenCalled();
        for (const rect of brushGroup.querySelectorAll<SVGRectElement>('.selection, .handle')) {
            expect(rect.getAttribute('x')).toBe('0');
            expect(rect.getAttribute('y')).toBe('0');
            expect(rect.getAttribute('width')).toBe('0');
            expect(rect.getAttribute('height')).toBe('0');
        }

        act(() => root.unmount());
        container.remove();
    });
});
