// @vitest-environment node
import * as arrow from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { analyzeTable } from './analyze_table.js';
import { computeTableAggregates } from './tasks/table_aggregation.js';
import { ComputationStateVersion, ORDINAL_COLUMN, TableAggregationTask } from './computation_types.js';
import { DataFrame } from './data_frame.js';

describe('analyzeTable', () => {
    it('ignores results without columns', async () => {
        const dispatch = vi.fn();
        const connect = vi.fn(() => {
            throw new Error('zero-column results must not open a compute connection');
        });
        const database = { connect } as unknown as EmbeddedComputeDatabase;

        await expect(analyzeTable(
            1,
            arrow.tableFromArrays({}),
            dispatch,
            database,
            new TestLogger(),
        )).resolves.toBeUndefined();

        expect(connect).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe('computeTableAggregates', () => {
    function createIntegerAggregationTask(): TableAggregationTask {
        return {
            tableId: 1,
            tableVersion: new ComputationStateVersion(0, 0),
            columnEntries: [{
                type: ORDINAL_COLUMN,
                value: {
                    inputFieldName: 'value',
                    inputFieldType: new arrow.Int32(),
                    inputFieldNullable: false,
                    statsFields: null,
                    binFieldName: null,
                    binCount: 16,
                },
            }],
            inputDataFrame: new DataFrame({} as EmbeddedComputeDatabase, 'input'),
        };
    }

    async function computeIntegerColumnEntries(min: number, max: number) {
        const statsTable = arrow.tableFromArrays({
            _count: new BigInt64Array([BigInt(max - min + 1)]),
            _0_count: new BigInt64Array([BigInt(max - min + 1)]),
            _0_min: new Int32Array([min]),
            _0_max: new Int32Array([max]),
        });
        const statsDataFrame = {
            tableName: 'stats',
            readTable: vi.fn().mockResolvedValue(statsTable),
        } as unknown as DataFrame;

        const [, columnEntries] = await computeTableAggregates(
            createIntegerAggregationTask(),
            new TestLogger(),
            async <T>() => statsDataFrame as T,
        );
        return columnEntries;
    }

    it('uses one bin per value for small integer domains', async () => {
        const columnEntries = await computeIntegerColumnEntries(0, 9);

        expect(columnEntries[0]).toMatchObject({
            type: ORDINAL_COLUMN,
            value: { binCount: 10 },
        });
    });

    it('keeps the default bin count for wider integer domains', async () => {
        const columnEntries = await computeIntegerColumnEntries(0, 16);

        expect(columnEntries[0]).toMatchObject({
            type: ORDINAL_COLUMN,
            value: { binCount: 16 },
        });
    });
});
