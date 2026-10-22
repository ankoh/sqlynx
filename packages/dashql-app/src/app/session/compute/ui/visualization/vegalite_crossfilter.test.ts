import * as arrow from 'apache-arrow';
import { expressionInterpreter } from 'vega-interpreter';
import * as vega from 'vega';
import { compile } from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';
import { describe, expect, it, vi } from 'vitest';

import {
    filterTableToVegaCrossFilterRows,
    injectVegaStableScaleDomains,
    injectVegaLiteCrossFilter,
    MASK_ROW_ID_FIELD,
    VegaCrossFilterUpdater,
    VegaCrossFilterView,
} from './vegalite_crossfilter.js';

describe('injectVegaLiteCrossFilter', () => {
    it('prepends a row-id membership filter without mutating the authored spec', () => {
        const authored = {
            data: { values: [{ _rownum: 1, value: 4 }] },
            transform: [{ calculate: 'datum.value * 2', as: 'double' }],
            mark: 'bar',
            encoding: { x: { field: 'value', type: 'quantitative' } },
        } as TopLevelSpec;
        const snapshot = JSON.parse(JSON.stringify(authored));

        const binding = injectVegaLiteCrossFilter(authored, '_rownum');
        expect(binding.maskDatasetName).not.toBeNull();
        expect(binding.maskActiveSignalName).not.toBeNull();
        expect(binding.maskSelectedFieldName).not.toBeNull();
        const maskDatasetName = binding.maskDatasetName!;
        const maskActiveSignalName = binding.maskActiveSignalName!;
        const maskSelectedFieldName = binding.maskSelectedFieldName!;
        const runtime = binding.spec as TopLevelSpec & {
            datasets: Record<string, unknown>;
            params: Array<{ name: string; value?: unknown }>;
            transform: Array<Record<string, unknown>>;
        };

        expect(authored).toEqual(snapshot);
        expect(runtime.data).toEqual({ name: binding.sourceDatasetName });
        expect(runtime.datasets[binding.sourceDatasetName]).toBeUndefined();
        expect(runtime.datasets[maskDatasetName]).toEqual([]);
        expect(runtime.params[runtime.params.length - 1]).toEqual({ name: maskActiveSignalName, value: false });
        expect(runtime.transform[0]).toEqual({
            lookup: '_rownum',
            from: {
                data: { name: maskDatasetName },
                key: MASK_ROW_ID_FIELD,
                fields: [maskSelectedFieldName],
            },
            as: [maskSelectedFieldName],
            default: false,
        });
        expect(runtime.transform[1].filter).toContain(`datum["${maskSelectedFieldName}"] === true`);
        expect(runtime.transform[2]).toEqual(snapshot.transform[0]);
    });

    it('avoids authored dataset and parameter names and quotes unusual row fields', () => {
        const authored = {
            datasets: { __dashql_crossfilter_ids: [] },
            params: [{ name: '__dashql_crossfilter_active', value: true }],
            mark: 'point',
        } as unknown as TopLevelSpec;

        const binding = injectVegaLiteCrossFilter(
            authored,
            'row "id"\\value',
            ['__dashql_crossfilter_selected'],
        );
        const runtime = binding.spec as TopLevelSpec & { transform: Array<Record<string, unknown>> };

        expect(binding.maskDatasetName).toBe('__dashql_crossfilter_ids_2');
        expect(binding.maskActiveSignalName).toBe('__dashql_crossfilter_active_2');
        expect(binding.maskSelectedFieldName).toBe('__dashql_crossfilter_selected_2');
        expect(runtime.transform[0].lookup).toBe('row "id"\\value');
    });

    it('injects only the named runtime source when row IDs are unavailable', () => {
        const authored = {
            data: { values: [{ value: 4 }] },
            mark: 'point',
        } as TopLevelSpec;

        const binding = injectVegaLiteCrossFilter(authored, null, ['value']);
        const runtime = binding.spec as TopLevelSpec & {
            datasets: Record<string, unknown>;
            params: unknown[];
            transform: unknown[];
        };

        expect(runtime.data).toEqual({ name: binding.sourceDatasetName });
        expect(runtime.datasets).toEqual({});
        expect(runtime.params).toEqual([]);
        expect(runtime.transform).toEqual([]);
        expect(binding.maskDatasetName).toBeNull();
    });

    it('updates an aggregate through the named mask with the CSP interpreter', async () => {
        const authored = {
            data: {
                values: [
                    { _rownum: 1, category: 'A' },
                    { _rownum: 2, category: 'A' },
                    { _rownum: 3, category: 'B' },
                ],
            },
            transform: [{ aggregate: [{ op: 'count', as: 'count' }], groupby: ['category'] }],
            mark: 'bar',
            encoding: {
                x: { field: 'category', type: 'nominal' },
                y: { field: 'count', type: 'quantitative' },
            },
        } as TopLevelSpec;
        const binding = injectVegaLiteCrossFilter(authored, '_rownum');
        expect(binding.maskDatasetName).not.toBeNull();
        expect(binding.maskActiveSignalName).not.toBeNull();
        expect(binding.maskSelectedFieldName).not.toBeNull();
        const maskDatasetName = binding.maskDatasetName!;
        const maskActiveSignalName = binding.maskActiveSignalName!;
        const maskSelectedFieldName = binding.maskSelectedFieldName!;
        const sourceRows = (authored.data as { values: object[] }).values;
        const compiled = compile(binding.spec).spec;
        const aggregateData = compiled.data?.find(data =>
            data.transform?.some(transform => transform.type === 'aggregate'));
        expect(aggregateData?.name).toBeDefined();

        const runtime = vega.parse(compiled, {}, { ast: true });
        const view = new vega.View(runtime, { expr: expressionInterpreter });
        view.data(binding.sourceDatasetName, sourceRows);
        await view.runAsync();
        expect(view.data(aggregateData!.name)).toEqual(expect.arrayContaining([
            expect.objectContaining({ category: 'A', count: 2 }),
            expect.objectContaining({ category: 'B', count: 1 }),
        ]));

        view
            .data(maskDatasetName, [{
                [MASK_ROW_ID_FIELD]: 3,
                [maskSelectedFieldName]: true,
            }])
            .signal(maskActiveSignalName, true);
        await view.runAsync();
        expect(view.data(aggregateData!.name)).toEqual([
            expect.objectContaining({ category: 'B', count: 1 }),
        ]);

        view
            .data(maskDatasetName, [])
            .signal(maskActiveSignalName, false);
        await view.runAsync();
        expect(view.data(aggregateData!.name)).toHaveLength(2);
        view.finalize();
    });
});

describe('filterTableToVegaCrossFilterRows', () => {
    it('converts integer and bigint row ids to Vega numbers', () => {
        const intTable = arrow.tableFromArrays({ _rownum: new Int32Array([1, 4]) });
        const bigintTable = arrow.tableFromArrays({ _rownum: new BigInt64Array([2n, 8n]) });

        expect(filterTableToVegaCrossFilterRows(intTable, 'selected')).toEqual([
            { [MASK_ROW_ID_FIELD]: 1, selected: true },
            { [MASK_ROW_ID_FIELD]: 4, selected: true },
        ]);
        expect(filterTableToVegaCrossFilterRows(bigintTable, 'selected')).toEqual([
            { [MASK_ROW_ID_FIELD]: 2, selected: true },
            { [MASK_ROW_ID_FIELD]: 8, selected: true },
        ]);
    });

    it('rejects a table that is not a row-id relation', () => {
        const table = arrow.tableFromArrays({ a: [1], b: [2] });
        expect(filterTableToVegaCrossFilterRows(table, 'selected')).toEqual([]);
    });
});

describe('injectVegaStableScaleDomains', () => {
    it('adds collision-safe domainRaw signals only to data-driven scales', () => {
        const compiled = {
            signals: [{ name: '__dashql_stable_domain', value: ['authored'] }],
            scales: [
                { name: 'x', type: 'band', domain: { data: 'table', field: 'category' } },
                { name: 'y', type: 'linear', domain: [0, 100] },
                { name: 'color', type: 'ordinal', domain: { data: 'table', field: 'category' }, domainRaw: { signal: 'authored' } },
            ],
        } as vega.Spec;

        const binding = injectVegaStableScaleDomains(compiled);
        const runtime = binding.spec as vega.Spec & {
            scales: Array<Record<string, unknown>>;
            signals: Array<Record<string, unknown>>;
        };

        expect(binding.domains).toEqual([{
            scaleName: 'x',
            signalName: '__dashql_stable_domain_2',
        }]);
        expect(runtime.scales[0].domainRaw).toEqual({ signal: '__dashql_stable_domain_2' });
        expect(runtime.scales[1]).toEqual(compiled.scales![1]);
        expect(runtime.scales[2]).toEqual(compiled.scales![2]);
        expect(runtime.signals).toContainEqual({ name: '__dashql_stable_domain_2', value: null });
        expect(compiled.scales![0]).not.toHaveProperty('domainRaw');
    });

    it('keeps aggregate and categorical domains stable while filtering marks', async () => {
        const sourceRows = [
            { _rownum: 1, category: 'A' },
            { _rownum: 2, category: 'A' },
            { _rownum: 3, category: 'B' },
        ];
        const authored = {
            transform: [{ aggregate: [{ op: 'count', as: 'count' }], groupby: ['category'] }],
            mark: 'bar',
            encoding: {
                x: { field: 'category', type: 'nominal' },
                y: { field: 'count', type: 'quantitative' },
            },
        } as TopLevelSpec;
        const crossFilter = injectVegaLiteCrossFilter(authored, '_rownum');
        const stableScales = injectVegaStableScaleDomains(compile(crossFilter.spec).spec);
        const aggregateData = stableScales.spec.data?.find(data =>
            data.transform?.some(transform => transform.type === 'aggregate'));
        expect(aggregateData?.name).toBeDefined();

        const runtime = vega.parse(stableScales.spec, {}, { ast: true });
        const view = new vega.View(runtime, { expr: expressionInterpreter });
        const updater = new VegaCrossFilterUpdater(
            view,
            crossFilter.sourceDatasetName,
            sourceRows,
            crossFilter.maskDatasetName,
            crossFilter.maskActiveSignalName,
            undefined,
            stableScales.domains,
        );
        updater.update({
            active: true,
            rows: [{
                [MASK_ROW_ID_FIELD]: 3,
                [crossFilter.maskSelectedFieldName!]: true,
            }],
        });

        await vi.waitFor(() => expect(view.data(aggregateData!.name)).toEqual([
            expect.objectContaining({ category: 'B', count: 1 }),
        ]));
        expect(view.scale('x').domain()).toEqual(['A', 'B']);
        expect(view.scale('y').domain()).toEqual([0, 2]);
        updater.dispose();
        view.finalize();
    });
});

describe('VegaCrossFilterUpdater', () => {
    it('serializes runs and coalesces pending masks', async () => {
        let resolveFirstRun: (() => void) | null = null;
        const firstRun = new Promise<void>(resolve => {
            resolveFirstRun = resolve;
        });
        const runAsync = vi.fn()
            .mockImplementationOnce(() => firstRun)
            .mockResolvedValue(undefined);
        const data = vi.fn();
        const signal = vi.fn();
        const view = {
            data: (...args: unknown[]) => {
                data(...args);
                return view;
            },
            signal: (...args: unknown[]) => {
                signal(...args);
                return view;
            },
            scale: vi.fn(),
            runAsync,
        } as VegaCrossFilterView;
        const updater = new VegaCrossFilterUpdater(view, 'source', [{ value: 1 }], 'mask', 'active');

        updater.update({ active: true, rows: [{ [MASK_ROW_ID_FIELD]: 1 }] });
        updater.update({ active: true, rows: [{ [MASK_ROW_ID_FIELD]: 2 }] });
        updater.update({ active: false, rows: [] });
        expect(runAsync).toHaveBeenCalledTimes(1);

        resolveFirstRun!();
        await firstRun;
        await vi.waitFor(() => expect(runAsync).toHaveBeenCalledTimes(2));

        expect(data).toHaveBeenNthCalledWith(1, 'source', [{ value: 1 }]);
        expect(data).toHaveBeenNthCalledWith(2, 'mask', [{ [MASK_ROW_ID_FIELD]: 1 }]);
        expect(data).toHaveBeenNthCalledWith(3, 'mask', []);
        expect(signal).toHaveBeenNthCalledWith(2, 'active', false);
    });

    it('drops queued work after disposal', async () => {
        let resolveRun: (() => void) | null = null;
        const run = new Promise<void>(resolve => {
            resolveRun = resolve;
        });
        const runAsync = vi.fn(() => run);
        const view = {
            data: vi.fn().mockReturnThis(),
            signal: vi.fn().mockReturnThis(),
            scale: vi.fn(),
            runAsync,
        } as unknown as VegaCrossFilterView;
        const updater = new VegaCrossFilterUpdater(view, 'source', [], 'mask', 'active');

        updater.update({ active: true, rows: [{ [MASK_ROW_ID_FIELD]: 1 }] });
        updater.update({ active: true, rows: [{ [MASK_ROW_ID_FIELD]: 2 }] });
        updater.dispose();
        resolveRun!();
        await run;
        await Promise.resolve();

        expect(runAsync).toHaveBeenCalledTimes(1);
    });
});
