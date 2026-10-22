import * as React from 'react';
import * as d3 from 'd3';

const BRUSH_SETTLE_DELAY_MS = 120;

function hideBrushSelection(container: SVGGElement): void {
    d3.select(container)
        .selectAll<SVGRectElement, unknown>('.selection, .handle')
        .style('display', 'none')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 0)
        .attr('height', 0);
}

export class SettledBrushUpdates<T> {
    private timeout: number | null = null;
    private pending: T | null = null;

    public schedule(event: T, callback: (event: T) => void): void {
        this.pending = event;
        if (this.timeout != null) {
            window.clearTimeout(this.timeout);
        }
        this.timeout = window.setTimeout(() => {
            this.timeout = null;
            const pending = this.pending;
            this.pending = null;
            if (pending != null) {
                callback(pending);
            }
        }, BRUSH_SETTLE_DELAY_MS);
    }

    public flush(event: T, callback: (event: T) => void): void {
        this.cancel();
        callback(event);
    }

    public cancel(): void {
        if (this.timeout != null) {
            window.clearTimeout(this.timeout);
            this.timeout = null;
        }
        this.pending = null;
    }
}

interface HistogramBrushOptions {
    xScale: d3.ScaleBand<string>;
    height: number;
    selection: [number, number] | null;
    onBrushUpdate: (event: d3.D3BrushEvent<unknown>) => void;
    onClear: () => void;
    onBrushingChange?: (isBrushing: boolean) => void;
}

export function useHistogramBrush(options: HistogramBrushOptions): {
    brushContainer: React.RefObject<SVGGElement | null>;
    clearBrush: () => void;
} {
    const brushContainer = React.useRef<SVGGElement>(null);
    const brushBehavior = React.useRef<d3.BrushBehavior<unknown> | null>(null);
    const syncingSelection = React.useRef(false);
    const settledBrushUpdates = React.useRef(new SettledBrushUpdates<d3.D3BrushEvent<unknown>>());

    const onBrushUpdateRef = React.useRef(options.onBrushUpdate);
    onBrushUpdateRef.current = options.onBrushUpdate;

    const onBrushStart = React.useCallback(() => {
        if (syncingSelection.current) {
            return;
        }
        settledBrushUpdates.current.cancel();
        options.onBrushingChange?.(true);
    }, [options.onBrushingChange]);

    const onBrushMove = React.useCallback((event: d3.D3BrushEvent<unknown>) => {
        if (syncingSelection.current) {
            return;
        }
        settledBrushUpdates.current.schedule(event, pending => onBrushUpdateRef.current(pending));
    }, []);

    const onBrushEnd = React.useCallback((event: d3.D3BrushEvent<unknown>) => {
        if (syncingSelection.current) {
            return;
        }
        settledBrushUpdates.current.flush(event, options.onBrushUpdate);
        options.onBrushingChange?.(false);
    }, [options.onBrushUpdate, options.onBrushingChange]);

    const onBrushStartRef = React.useRef(onBrushStart);
    const onBrushMoveRef = React.useRef(onBrushMove);
    const onBrushEndRef = React.useRef(onBrushEnd);
    onBrushStartRef.current = onBrushStart;
    onBrushMoveRef.current = onBrushMove;
    onBrushEndRef.current = onBrushEnd;

    React.useEffect(() => () => settledBrushUpdates.current.cancel(), []);

    React.useLayoutEffect(() => {
        const brush = d3.brushX()
            .extent([
                [options.xScale.range()[0], 0],
                [options.xScale.range()[1], options.height]
            ])
            .on('start', () => onBrushStartRef.current())
            .on('brush', event => onBrushMoveRef.current(event))
            .on('end', event => onBrushEndRef.current(event));
        brushBehavior.current = brush;

        d3.select(brushContainer.current!)
            .selectChildren()
            .remove();
        d3.select(brushContainer.current!)
            .call(brush)
            .selectAll('rect')
            .attr('y', 0)
            .attr('height', options.height);
        if (options.selection == null) {
            hideBrushSelection(brushContainer.current!);
        }
        return () => {
            brushBehavior.current = null;
        };
    }, [options.xScale, options.height]);

    React.useLayoutEffect(() => {
        const container = brushContainer.current;
        const brush = brushBehavior.current;
        if (container == null || brush == null) {
            return;
        }
        const current = d3.brushSelection(container) as [number, number] | null;
        const next = options.selection;
        if (current == null ? next == null : next != null && current[0] === next[0] && current[1] === next[1]) {
            return;
        }
        settledBrushUpdates.current.cancel();
        syncingSelection.current = true;
        try {
            d3.select(container).call(brush.move, next);
            if (next == null) {
                hideBrushSelection(container);
            }
        } finally {
            syncingSelection.current = false;
        }
    }, [options.selection, options.xScale, options.height]);

    const clearBrush = React.useCallback(() => {
        const container = brushContainer.current;
        const brush = brushBehavior.current;
        if (container != null && brush != null) {
            d3.select(container).call(brush.move, null);
            hideBrushSelection(container);
            return;
        }
        options.onClear();
    }, [options.onClear]);

    return { brushContainer, clearBrush };
}
