import '@jest/globals';

import * as arrow from 'apache-arrow';
import * as sqlynx_compute from '@ankoh/sqlynx-compute';
import * as pb from '@ankoh/sqlynx-protobuf';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { DataFrameIpcStreamIterable, dataFrameFromTable as createDataFrameFromTable, readDataFrame } from './sqlynx_compute.js';

const distPath = path.resolve(fileURLToPath(new URL('../../../sqlynx-compute/dist/', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx_compute_bg.wasm');

beforeAll(async () => {
    expect(async () => await fs.promises.access(wasmPath)).resolves;
    const buf = await fs.promises.readFile(wasmPath);
    await sqlynx_compute.default({
        module_or_path: buf
    });
    const version = sqlynx_compute.getVersion();
    expect(version.text).toMatch(/^[0-9]+.[0-9]+.[0-9]+(\-dev\.[0-9]+)?$/);
});

describe('SQLynxCompute Arrow IO', () => {
    const testData = new Int32Array([
        1, 2, 3, 4, 5, 6, 7, 8
    ]);
    const inTable0 = arrow.tableFromArrays({
        test: testData,
    });

    it('Ingest', async () => {
        const dataFrame = createDataFrameFromTable(inTable0);
        dataFrame.free();
    });

    it('IPC stream', async () => {
        const dataFrame = createDataFrameFromTable(inTable0);

        const dataFrameStream = dataFrame.createIpcStream();
        const stream = new DataFrameIpcStreamIterable(dataFrame, dataFrameStream);
        const batchReader = arrow.RecordBatchReader.from<{ 'test': arrow.Int32 }>(stream);
        expect(batchReader.isStream()).toBeTruthy();

        const table = new arrow.Table(batchReader);
        const mapped = table.toArray().map(o => ({ test: o.test }));
        expect(mapped).toEqual([
            { test: 1 },
            { test: 2 },
            { test: 3 },
            { test: 4 },
            { test: 5 },
            { test: 6 },
            { test: 7 },
            { test: 8 },
        ]);

        dataFrameStream.free();
        dataFrame.free();
    })
});

const testOrderByColumn = async (inTable: arrow.Table, columnName: string, asc: boolean, nullsFirst: boolean, mapper: (o: any) => any, expected: any[]) => {
    const dataFrame = createDataFrameFromTable(inTable);
    const dataFrameTransform = new pb.sqlynx_compute.pb.DataFrameTransform({
        orderBy: new pb.sqlynx_compute.pb.OrderByTransform({
            constraints: [{
                fieldName: columnName,
                ascending: asc,
                nullsFirst
            }]
        })
    });
    const orderByConfigBytes = dataFrameTransform.toBinary();
    const orderedFrame = await dataFrame.transform(orderByConfigBytes);
    dataFrame.free();

    const table = readDataFrame(orderedFrame);
    orderedFrame.free();

    const mapped = table.toArray().map(mapper);
    expect(mapped).toEqual(expected);
};

describe('SQLynxCompute OrderBy', () => {
    it('Float64', async () => {
        const t = arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3, 4]),
            score: new Float64Array([42.0, 10.2, 10.1, 30.005])
        });
        testOrderByColumn(t, "score", true, false, o => ({ id: o.id, score: o.score }), [
            { id: 3, score: 10.1 },
            { id: 2, score: 10.2 },
            { id: 4, score: 30.005 },
            { id: 1, score: 42.0 },
        ]);
    });
});

const testBinning = async (inTable: arrow.Table, columnName: string, expectedStats: any[], expectedBins: any[]) => {
    const inFrame = createDataFrameFromTable(inTable);
    const statsTransform = new pb.sqlynx_compute.pb.DataFrameTransform({
        groupBy: new pb.sqlynx_compute.pb.GroupByTransform({
            keys: [],
            aggregates: [
                new pb.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: columnName,
                    outputAlias: "min",
                    aggregationFunction: pb.sqlynx_compute.pb.AggregationFunction.Min,
                }),
                new pb.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: columnName,
                    outputAlias: "max",
                    aggregationFunction: pb.sqlynx_compute.pb.AggregationFunction.Max,
                })
            ]
        })
    });
    const statsFrame = await inFrame.transform(statsTransform.toBinary());

    const binTransform = new pb.sqlynx_compute.pb.DataFrameTransform({
        groupBy: new pb.sqlynx_compute.pb.GroupByTransform({
            keys: [
                new pb.sqlynx_compute.pb.GroupByKey({
                    fieldName: columnName,
                    outputAlias: "bin",
                    binning: new pb.sqlynx_compute.pb.GroupByKeyBinning({
                        statsMinimumFieldName: "min",
                        statsMaximumFieldName: "max",
                        binCount: 8,
                        outputBinWidthAlias: "bin_width",
                        outputBinLbAlias: "bin_lb",
                        outputBinUbAlias: "bin_ub",
                    })
                })
            ],
            aggregates: [
                new pb.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: columnName,
                    outputAlias: "count",
                    aggregationFunction: pb.sqlynx_compute.pb.AggregationFunction.CountStar,
                })
            ]
        }),
        orderBy: new pb.sqlynx_compute.pb.OrderByTransform({
            constraints: [{
                fieldName: "bin",
                ascending: true,
                nullsFirst: false,
            }]
        })
    });
    const binnedFrame = await inFrame.transformWithStats(binTransform.toBinary(), statsFrame);

    const statsTable = readDataFrame(statsFrame);
    const binnedTable = readDataFrame(binnedFrame);
    statsFrame.free();
    binnedFrame.free();
    inFrame.free();

    const stats = statsTable.toArray().map(o => ({ min: o.min, max: o.max }));
    const bins = binnedTable.toArray().map(o => ({
        bin: o.bin,
        binWidth: o.bin_width,
        binLB: o.bin_lb,
        binUB: o.bin_ub,
        count: o.count,
    }));
    expect(stats).toEqual(expectedStats);
    expect(bins).toEqual(expectedBins);
};

describe('SQLynxCompute Binning', () => {
    it('Float64', async () => {
        const t = arrow.tableFromArrays({
            id: new Int32Array([
                1, 2, 3, 4,
                5, 6, 7, 8,
                9, 10, 11, 12,
                13, 14, 15, 16,
            ]),
            score: new Float64Array([
                42, 10, 10, 30,
                436, 28054, 7554, 23269, 3972,
                17470, 25733, 5638, 27309, 11486,
                12329, 22070, 9231, 2636, 15536,
            ])
        });
        testBinning(t, "score", [{
            "max": 28054,
            "min": 10,
        }], [
            { bin: 0, binWidth: 3505.5, binLB: 10, binUB: 3515.5, count: 5n },
            {
                bin: 1,
                binWidth: 3505.5,
                binLB: 3515.5,
                binUB: 7021,
                count: 2n
            },
            {
                bin: 2,
                binWidth: 3505.5,
                binLB: 7021,
                binUB: 10526.5,
                count: 1n
            },
            {
                bin: 3,
                binWidth: 3505.5,
                binLB: 10526.5,
                binUB: 14032,
                count: 2n
            },
            {
                bin: 4,
                binWidth: 3505.5,
                binLB: 14032,
                binUB: 17537.5,
                count: 1n
            },
            {
                bin: 6,
                binWidth: 3505.5,
                binLB: 21043,
                binUB: 24548.5,
                count: 2n
            },
            {
                bin: 7,
                binWidth: 3505.5,
                binLB: 24548.5,
                binUB: 28054,
                count: 2n
            },
            {
                bin: 8,
                binWidth: 3505.5,
                binLB: 28054,
                binUB: 31559.5,
                count: 1n
            }
        ]);
    });
});
