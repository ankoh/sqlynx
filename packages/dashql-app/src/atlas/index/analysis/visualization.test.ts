import { describe, expect, it } from 'vitest';
import type { CompiledVisualization } from './core.js';
import { describeVisualization } from './visualization.js';

function vegalite(spec: object): string[] {
    const visualization: CompiledVisualization = {
        renderer: 'vegalite',
        vegaliteSpec: JSON.stringify(spec),
        markdown: null,
        umap: null,
    };
    return describeVisualization(visualization);
}

describe('describeVisualization', () => {
    it('names the mark when the chart has no better name', () => {
        expect(vegalite({ mark: 'point', encoding: { x: { field: 'Year', type: 'temporal' }, color: { field: 'Origin' } } })).toEqual([
            'vegalite point (x Year temporal, color Origin)',
        ]);
    });

    it('names scatter plots and bubble charts', () => {
        const xy = { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } };
        expect(vegalite({ mark: 'point', encoding: xy })).toEqual([
            'vegalite scatter plot (point, x a quantitative, y b quantitative)',
        ]);
        expect(vegalite({ mark: 'circle', encoding: { ...xy, size: { field: 'c', type: 'quantitative' } } })[0]).toMatch(
            /^vegalite bubble chart /,
        );
    });

    it('names histograms and shows the binning', () => {
        expect(
            vegalite({
                mark: 'bar',
                encoding: { x: { field: 'revenue', type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } },
            }),
        ).toEqual(['vegalite histogram (bar, x revenue binned quantitative, y count() quantitative)']);
    });

    it('tells stacked, normalized and plain bars apart', () => {
        const encoding = (stack?: unknown, color = 'category') => ({
            x: { field: 'date', type: 'temporal' },
            y: { field: 'revenue', type: 'quantitative', aggregate: 'sum', ...(stack !== undefined && { stack }) },
            color: { field: color, type: 'nominal' },
        });
        expect(vegalite({ mark: 'bar', encoding: encoding() })[0]).toMatch(/^vegalite stacked bar chart /);
        expect(vegalite({ mark: 'bar', encoding: encoding('normalize') })[0]).toBe(
            'vegalite normalized stacked bar chart (bar, x date temporal, y sum(revenue) quantitative normalized stack, color category nominal)',
        );
        expect(vegalite({ mark: 'bar', encoding: encoding(null) })[0]).toMatch(/^vegalite bar chart .*y sum\(revenue\) quantitative unstacked/);
        // A color that repeats the axis does not split the bars
        expect(vegalite({ mark: 'bar', encoding: { ...encoding(), x: { field: 'category', type: 'nominal' } } })[0]).toMatch(
            /^vegalite bar chart /,
        );
    });

    it('names grouped bars, time series, heatmaps, pie charts and maps', () => {
        const kinds = (mark: string, encoding: object) => vegalite({ mark, encoding })[0].split(' (')[0];
        expect(kinds('bar', { x: { field: 'a', type: 'nominal' }, xOffset: { field: 'b', type: 'nominal' } })).toBe('vegalite grouped bar chart');
        expect(kinds('line', { x: { field: 'd', type: 'temporal' } })).toBe('vegalite time series line chart');
        expect(kinds('line', { x: { field: 'd', type: 'ordinal' } })).toBe('vegalite line chart');
        expect(kinds('area', { x: { field: 'd', timeUnit: 'yearmonth' } })).toBe('vegalite time series area chart');
        expect(kinds('rect', { x: { field: 'a' }, y: { field: 'b' }, color: { field: 'c' } })).toBe('vegalite heatmap');
        expect(kinds('arc', { theta: { field: 'v', type: 'quantitative' } })).toBe('vegalite pie chart');
        expect(kinds('circle', { latitude: { field: 'lat' }, longitude: { field: 'lon' } })).toBe('vegalite map');
    });

    it('shows time units, sorting and constants', () => {
        expect(
            vegalite({
                mark: 'line',
                encoding: {
                    x: { field: 'date', type: 'temporal', timeUnit: 'month' },
                    y: { field: 'revenue', type: 'quantitative', sort: { field: 'revenue', op: 'sum', order: 'descending' } },
                    size: { value: 3 },
                    color: { datum: 'target' },
                },
            })[0],
        ).toBe(
            'vegalite time series line chart (line, x date month temporal, y revenue quantitative sort descending by sum(revenue)' +
                ', size value 3, color datum "target")',
        );
    });

    it('includes titles and descriptions', () => {
        expect(
            vegalite({
                title: { text: 'Revenue by region' },
                description: 'Yearly totals',
                mark: 'bar',
                encoding: { x: { field: 'region', type: 'nominal', axis: { title: 'Sales region' } } },
            }),
        ).toEqual(['vegalite bar chart titled "Revenue by region" described "Yearly totals" (bar, x region nominal titled "Sales region")']);
    });

    it('shows mark options and faceting', () => {
        expect(
            vegalite({
                mark: { type: 'line', point: true, interpolate: 'monotone' },
                encoding: { x: { field: 'd', type: 'ordinal' }, row: { field: 'region', type: 'nominal' } },
            })[0],
        ).toBe('vegalite line chart (line with points monotone interpolation, small multiples, x d ordinal, row region nominal)');
        expect(vegalite({ mark: { type: 'bar', orient: 'horizontal' }, encoding: {} })).toEqual(['vegalite bar chart (horizontal bar)']);
    });

    it('describes every layer against the shared encoding', () => {
        expect(
            vegalite({
                title: 'Revenue vs target',
                encoding: { x: { field: 'date', type: 'temporal' } },
                layer: [
                    { mark: 'line', encoding: { y: { field: 'revenue', type: 'quantitative' }, color: { field: 'category', type: 'nominal' } } },
                    { mark: 'point', encoding: { y: { field: 'target', type: 'quantitative' } } },
                ],
                resolve: { scale: { y: 'independent' }, legend: { color: 'shared' } },
            }),
        ).toEqual([
            'vegalite layer 1 of 2 time series line chart titled "Revenue vs target" ' +
                '(line, x date temporal, y revenue quantitative, color category nominal, independent y scale)',
            'vegalite layer 2 of 2 point (x date temporal, y target quantitative)',
        ]);
    });

    it('cuts crowded charts to a fixed number of items', () => {
        const channels = ['x', 'y', 'color', 'size', 'shape', 'opacity', 'detail', 'tooltip', 'text', 'angle'];
        const encoding = Object.fromEntries(channels.map(ch => [ch, { field: `${ch}_col`, type: 'nominal' }]));
        const [entry] = vegalite({ mark: 'text', encoding });
        // Mark kinds without a name show no mark item, so the first 8 channels remain
        expect(entry).toBe(
            'vegalite text (' + channels.slice(0, 8).map(ch => `${ch} ${ch}_col nominal`).join(', ') + ', +2 more)',
        );
    });

    it('describes the other renderers', () => {
        const base = { vegaliteSpec: null, markdown: null, umap: null };
        expect(describeVisualization({ ...base, renderer: 'markdown', markdown: { template: '{{a}}', fields: ['a', 'b'] } })).toEqual([
            'markdown (a, b)',
        ]);
        expect(
            describeVisualization({ ...base, renderer: 'umap', umap: { vectorColumn: 'emb', categoryColumn: '', labelColumn: 'name' } }),
        ).toEqual(['umap (vector emb, label name)']);
        expect(describeVisualization({ ...base, renderer: 'table' })).toEqual(['table']);
    });

    it('survives broken specs', () => {
        expect(describeVisualization({ renderer: 'vegalite', vegaliteSpec: '{', markdown: null, umap: null })).toEqual(['vegalite']);
    });
});
