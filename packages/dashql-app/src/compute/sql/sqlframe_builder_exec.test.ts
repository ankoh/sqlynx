import * as arrow from 'apache-arrow';
import { SQLFrame } from './sqlframe_builder.js';
import { setupWebHyperDB } from '../../platform/hyperdb/hyperdb_provider_web.js';
import { TestLogger } from '../../platform/logger/test_logger.js';
import {
    HyperDB,
    HyperDBConnection,
} from '../../platform/hyperdb/hyperdb_wasm.js';

function toPlainObjects(table: arrow.Table): any[] {
    return table.toArray().map(row => {
        const obj: any = {};
        for (const key of Object.keys(row)) {
            obj[key] = row[key];
        }
        return obj;
    });
}

describe('SQLFrame execution', () => {
    let database: HyperDB | null = null;
    let conn!: HyperDBConnection;

    beforeEach(async () => {
        database = await setupWebHyperDB('sqlframe_builder_exec_test', new TestLogger());
        conn = await database.connect();
    }, 60_000);

    afterEach(async () => {
        if (conn) await conn.close();
        await database?.terminate();
    });

    it('order by Float64', async () => {
        const table = arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3, 4]),
            score: new Float64Array([42.0, 10.2, 10.1, 30.005]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .orderBy([{ field: "score", ascending: true }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows).toEqual([
            { id: 3, score: 10.1 },
            { id: 2, score: 10.2 },
            { id: 4, score: 30.005 },
            { id: 1, score: 42.0 },
        ]);
    });

    it('row number', async () => {
        const table = arrow.tableFromArrays({
            id: new Int32Array([10, 20, 30]),
            name: ['Alice', 'Bob', 'Charlie'],
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .rowNumber("rn")
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows.length).toBe(3);
        const rns = rows.map((r: any) => r.rn).sort();
        expect(rns).toEqual([1n, 2n, 3n]);
    });

    it('value identifier (dense_rank)', async () => {
        const table = arrow.tableFromArrays({
            category: ['B', 'A', 'C', 'A', 'B'],
            value: new Float64Array([1, 2, 3, 4, 5]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .valueIdentifier("category", "cat_id")
            .orderBy([{ field: "cat_id", ascending: true }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        const aRows = rows.filter((r: any) => r.category === 'A');
        const bRows = rows.filter((r: any) => r.category === 'B');
        const cRows = rows.filter((r: any) => r.category === 'C');

        expect(new Set(aRows.map((r: any) => r.cat_id)).size).toBe(1);
        expect(new Set(bRows.map((r: any) => r.cat_id)).size).toBe(1);
        expect(new Set(cRows.map((r: any) => r.cat_id)).size).toBe(1);

        const ids = [...new Set(rows.map((r: any) => r.cat_id))].sort();
        expect(ids).toEqual([1n, 2n, 3n]);
    });

    it('filters rows by categorical value identifier', async () => {
        const table = arrow.tableFromArrays({
            category: ['B', 'A', null, 'A', 'B'],
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .rowNumber("rn")
            .valueIdentifier("category", "cat_id")
            .filter("cat_id", "=", 1)
            .project(["rn"])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows.map((row: any) => row.rn).sort()).toEqual([2n, 4n]);
    });

    it('assigns null categories a filterable value identifier', async () => {
        const table = arrow.tableFromArrays({
            category: ['B', 'A', null, 'A', 'B'],
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .rowNumber("rn")
            .valueIdentifier("category", "cat_id")
            .filter("cat_id", "=", 3)
            .project(["rn"])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows.map((row: any) => row.rn)).toEqual([3n]);
    });

    it('scalar filter range', async () => {
        const table = arrow.tableFromArrays({
            score: new Float64Array([42.0, 10.2, 10.1, 30.005]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .rowNumber("rn")
            .filter("score", ">=", 10.1)
            .filter("score", "<=", 10.2)
            .project(["rn"])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows.length).toBe(2);
        const rns = rows.map((r: any) => r.rn).sort();
        expect(rns).toEqual([2n, 3n]);
    });

    it('bins temporal values using epoch seconds', async () => {
        await conn.query(`CREATE TABLE input (occurred_at TIMESTAMP)`);
        await conn.query(
            `INSERT INTO input VALUES ` +
            `(TIMESTAMP '2024-01-01 00:00:00'), ` +
            `(TIMESTAMP '2024-01-01 00:00:05'), ` +
            `(TIMESTAMP '2024-01-01 00:00:10')`,
        );
        await conn.query(
            `CREATE TABLE stats AS ` +
            `SELECT MIN(occurred_at) AS min_time, MAX(occurred_at) AS max_time FROM input`,
        );

        const sql = SQLFrame.from("input")
            .binning({
                fieldName: "occurred_at",
                statsTable: "stats",
                statsMinField: "min_time",
                statsMaxField: "max_time",
                binCount: 2,
                outputAlias: "time_bin",
                toNumericFn: "EPOCH",
            })
            .orderBy([{ field: "occurred_at" }])
            .toSQL();
        const rows = toPlainObjects(await conn.query(sql));

        expect(rows.map(row => row.time_bin)).toEqual([0, 1, 2]);
    });

    it('bins boolean values', async () => {
        await conn.query(`CREATE TABLE input (email_opt_out BOOLEAN)`);
        await conn.query(`INSERT INTO input VALUES (FALSE), (TRUE), (NULL)`);
        await conn.query(
            `CREATE TABLE stats AS ` +
            `SELECT MIN(email_opt_out) AS min_value, MAX(email_opt_out) AS max_value FROM input`,
        );

        const sql = SQLFrame.from("input")
            .binning({
                fieldName: "email_opt_out",
                statsTable: "stats",
                statsMinField: "min_value",
                statsMaxField: "max_value",
                binCount: 16,
                outputAlias: "value_bin",
                toNumericFn: "BOOLEAN",
            })
            .orderBy([{ field: "email_opt_out" }])
            .toSQL();
        const rows = toPlainObjects(await conn.query(sql));

        expect(rows.map(row => row.value_bin)).toEqual([0, 16, null]);
    });

    it('semi-join filter', async () => {
        const mainTable = arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3, 4, 5]),
            name: ['a', 'b', 'c', 'd', 'e'],
        });
        const filterTable = arrow.tableFromArrays({
            filter_id: new Int32Array([2, 4]),
        });
        await conn.insertArrowTable(mainTable, { name: 'input', create: true });
        await conn.insertArrowTable(filterTable, { name: 'ftable', create: true });

        const sql = SQLFrame.from("input")
            .semiJoinFilter("id", "ftable", "filter_id")
            .orderBy([{ field: "id" }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows).toEqual([
            { id: 2, name: 'b' },
            { id: 4, name: 'd' },
        ]);
    });

    it('group by with count', async () => {
        const table = arrow.tableFromArrays({
            category: ['A', 'B', 'A', 'B', 'A'],
            value: new Float64Array([10, 20, 30, 40, 50]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{ fieldName: "category", outputAlias: "key" }],
                aggregates: [{ func: "count_star", outputAlias: "cnt" }],
            })
            .orderBy([{ field: "key" }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows).toEqual([
            { key: 'A', cnt: 3n },
            { key: 'B', cnt: 2n },
        ]);
    });

    it('group by with aggregates', async () => {
        const table = arrow.tableFromArrays({
            category: ['A', 'B', 'A', 'B', 'A'],
            value: new Float64Array([10, 20, 30, 40, 50]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{ fieldName: "category", outputAlias: "cat" }],
                aggregates: [
                    { func: "min", fieldName: "value", outputAlias: "min_val" },
                    { func: "max", fieldName: "value", outputAlias: "max_val" },
                    { func: "avg", fieldName: "value", outputAlias: "avg_val" },
                ],
            })
            .orderBy([{ field: "cat" }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows).toEqual([
            { cat: 'A', min_val: 10, max_val: 50, avg_val: 30 },
            { cat: 'B', min_val: 20, max_val: 40, avg_val: 30 },
        ]);
    });

    it('binned group by', async () => {
        const table = arrow.tableFromArrays({
            score: new Float64Array([
                42, 10, 10, 30,
                436, 28054, 7554, 23269, 3972,
                17470, 25733, 5638, 27309, 11486,
                12329, 22070, 9231, 2636, 15536,
            ]),
        });
        const statsTable = arrow.tableFromArrays({
            min_score: new Float64Array([10]),
            max_score: new Float64Array([28054]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });
        await conn.insertArrowTable(statsTable, { name: 'stats', create: true });

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{
                    fieldName: "score",
                    outputAlias: "bin",
                    binning: {
                        binCount: 8,
                        statsTable: "stats",
                        statsMinField: "min_score",
                        statsMaxField: "max_score",
                        outputBinWidthAlias: "bin_width",
                        outputBinLbAlias: "bin_lb",
                        outputBinUbAlias: "bin_ub",
                        includeNullBin: false,
                    },
                }],
                aggregates: [{ func: "count_star", outputAlias: "count" }],
            })
            .orderBy([{ field: "bin", ascending: true }])
            .toSQL();
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);

        expect(rows.length).toBe(8);

        // bin_width = (28054 - 10) / 8 = 3505.5
        // Bin assignments for all 19 values:
        //   bin 0: 10, 10, 30, 42, 436, 2636 → 6
        //   bin 1: 3972, 5638 → 2
        //   bin 2: 7554, 9231 → 2
        //   bin 3: 11486, 12329 → 2
        //   bin 4: 15536, 17470 → 2
        //   bin 5: (empty) → null
        //   bin 6: 22070, 23269 → 2
        //   bin 7: 25733, 27309, 28054 → 3
        expect(rows[0].bin).toBe(0);
        expect(rows[0].count).toBe(6n);

        expect(rows[1].bin).toBe(1);
        expect(rows[1].count).toBe(2n);

        expect(rows[5].bin).toBe(5);
        expect(rows[5].count).toBeNull();

        expect(rows[7].bin).toBe(7);
        expect(rows[7].count).toBe(3n);

        for (const row of rows) {
            expect(row.bin_width).toBeCloseTo(3505.5, 1);
        }

        expect(rows[0].bin_lb).toBeCloseTo(10, 1);
        expect(rows[0].bin_ub).toBeCloseTo(3515.5, 1);
        expect(rows[7].bin_lb).toBeCloseTo(24548.5, 1);
        expect(rows[7].bin_ub).toBeCloseTo(28054, 1);
    });

    it('uses unit-width bins for small integer domains', async () => {
        const table = arrow.tableFromArrays({
            value: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        });
        const statsTable = arrow.tableFromArrays({
            min_value: new Int32Array([0]),
            max_value: new Int32Array([9]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });
        await conn.insertArrowTable(statsTable, { name: 'stats', create: true });

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{
                    fieldName: "value",
                    outputAlias: "bin",
                    binning: {
                        binCount: 10,
                        minBinWidth: 1,
                        statsTable: "stats",
                        statsMinField: "min_value",
                        statsMaxField: "max_value",
                        outputBinWidthAlias: "bin_width",
                        outputBinLbAlias: "bin_lb",
                        outputBinUbAlias: "bin_ub",
                    },
                }],
                aggregates: [{ func: "count_star", outputAlias: "count" }],
            })
            .orderBy([{ field: "bin", ascending: true }])
            .toSQL();
        const rows = toPlainObjects(await conn.query(sql));

        expect(rows).toHaveLength(10);
        expect(rows.map(row => row.count)).toEqual(Array(10).fill(1n));
        expect(rows.map(row => row.bin_lb)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('groups pre-binned boolean values', async () => {
        await conn.query(`CREATE TABLE input (email_opt_out BOOLEAN, value_bin DOUBLE PRECISION)`);
        await conn.query(`INSERT INTO input VALUES (FALSE, 0), (TRUE, 16), (NULL, NULL)`);
        await conn.query(
            `CREATE TABLE stats AS ` +
            `SELECT MIN(email_opt_out) AS min_value, MAX(email_opt_out) AS max_value FROM input`,
        );

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{
                    fieldName: "email_opt_out",
                    outputAlias: "bin",
                    binning: {
                        preBinnedFieldName: "value_bin",
                        statsTable: "stats",
                        statsMinField: "min_value",
                        statsMaxField: "max_value",
                        binCount: 16,
                        outputBinWidthAlias: "bin_width",
                        outputBinLbAlias: "bin_lb",
                        outputBinUbAlias: "bin_ub",
                        includeNullBin: true,
                        toNumericFn: "BOOLEAN",
                    },
                }],
                aggregates: [{ func: "count_star", outputAlias: "count" }],
            })
            .orderBy([{ field: "bin" }])
            .toSQL();
        const rows = toPlainObjects(await conn.query(sql));

        expect(rows).toHaveLength(17);
        expect(rows[0]).toMatchObject({ bin: 0, count: 1n, bin_lb: 0, bin_ub: 0.0625 });
        expect(rows[15]).toMatchObject({ bin: 15, count: 1n, bin_lb: 0.9375, bin_ub: 1 });
        expect(rows[16]).toMatchObject({ bin: 16, count: 1n, bin_lb: null, bin_ub: null });
    });

    it('binned group by with NaN / Inf / near-constant floats', async () => {
        // Floating-point columns commonly contain NaN/Inf, and
        // near-constant columns clamp bin_width to 1e-15, producing bin indices
        // far outside INT32 range. The clamp must happen before the INTEGER cast.
        // Web Hyper does not support REAL, so use its supported floating-point type.
        await conn.query(`CREATE TABLE input (score DOUBLE PRECISION)`);
        await conn.query(
            `INSERT INTO input VALUES ` +
            `(10.0), (10.0), ('NaN'::DOUBLE PRECISION), ` +
            `('Infinity'::DOUBLE PRECISION), ('-Infinity'::DOUBLE PRECISION), (10.0000001)`
        );
        const statsSql = SQLFrame.from("input")
            .groupBy({
                keys: [],
                aggregates: [
                    { func: "min", fieldName: "score", outputAlias: "min_score" },
                    { func: "max", fieldName: "score", outputAlias: "max_score" },
                ],
            })
            .toSQL();
        await conn.query(`CREATE TABLE stats AS ${statsSql}`);

        const sql = SQLFrame.from("input")
            .groupBy({
                keys: [{
                    fieldName: "score",
                    outputAlias: "bin",
                    binning: {
                        binCount: 16,
                        statsTable: "stats",
                        statsMinField: "min_score",
                        statsMaxField: "max_score",
                        outputBinWidthAlias: "bin_width",
                        outputBinLbAlias: "bin_lb",
                        outputBinUbAlias: "bin_ub",
                        includeNullBin: true,
                    },
                }],
                aggregates: [{ func: "count_star", outputAlias: "count" }],
            })
            .orderBy([{ field: "bin", ascending: true }])
            .toSQL();
        // Must not throw a conversion / out-of-range error.
        const result = await conn.query(sql);
        const rows = toPlainObjects(result);
        // 16 regular bins + 1 null bin
        expect(rows.length).toBe(17);
        // Every bin index stays within [0, 16].
        for (const row of rows) {
            expect(row.bin).toBeGreaterThanOrEqual(0);
            expect(row.bin).toBeLessThanOrEqual(16);
        }
    });

    it('projection', async () => {
        const table = arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3]),
            name: ['Alice', 'Bob', 'Charlie'],
            score: new Float64Array([85, 90, 95]),
        });
        await conn.insertArrowTable(table, { name: 'input', create: true });

        const sql = SQLFrame.from("input")
            .project(["id", "name"])
            .toSQL();
        const result = await conn.query(sql);

        expect(result.numCols).toBe(2);
        const rows = toPlainObjects(result);
        expect(rows).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Charlie' },
        ]);
    });

    it('casts currently searchable result types to text for ILIKE', async () => {
        await conn.query(`CREATE TABLE input (
            name TEXT,
            "score" DOUBLE PRECISION,
            flagged BOOLEAN,
            occurred_at TIMESTAMP
        )`);
        await conn.query(
            `INSERT INTO input VALUES ` +
            `('Alice', 10.5, TRUE, TIMESTAMP '2024-01-01 00:00:00'), ` +
            `('Bob', 20, FALSE, TIMESTAMP '2024-02-02 12:00:00')`,
        );

        const rows = toPlainObjects(await conn.query(
            `SELECT ` +
            `CAST(name AS TEXT) AS name_text, ` +
            `CAST("score" AS TEXT) AS score_text, ` +
            `CAST(flagged AS TEXT) AS flagged_text, ` +
            `CAST(occurred_at AS TEXT) AS occurred_text, ` +
            `CAST(ARRAY['red', 'blue'] AS TEXT) AS tags_text ` +
            `FROM input ` +
            `WHERE CAST(name AS TEXT) ILIKE '%ali%' ` +
            `AND CAST(ARRAY['red', 'blue'] AS TEXT) ILIKE '%red%'`,
        ));

        expect(rows.length).toBe(1);
        expect(rows[0].name_text.toLowerCase()).toContain('alice');
        expect(String(rows[0].score_text)).toContain('10');
        expect(String(rows[0].flagged_text).toLowerCase()).toMatch(/t|true|1/);
        expect(String(rows[0].tags_text)).toContain('red');
    });

    it('aggregates matching data-search columns per row', async () => {
        await conn.query(`CREATE TABLE input (_rownum BIGINT, name TEXT, city TEXT)`);
        await conn.query(
            `INSERT INTO input VALUES ` +
            `(1, 'Alice', 'Boston'), ` +
            `(2, 'Bob', 'Austin'), ` +
            `(3, 'Carol', 'Seattle')`,
        );
        const { buildDataSearchSQL } = await import('./query_result_search_sql.js');
        const sql = buildDataSearchSQL('input', '_rownum', [
            { columnIdx: 0, columnGroupIdx: 1, fieldName: 'name' },
            { columnIdx: 1, columnGroupIdx: 2, fieldName: 'city' },
        ], 'a');
        const rows = toPlainObjects(await conn.query(sql!));
        expect(rows.map(row => Number(row.row_idx))).toEqual([1, 2, 3]);
        expect(Array.from(rows[0].column_indices, Number)).toEqual([0]);
        expect(Array.from(rows[1].column_indices, Number)).toEqual([1]);
        expect(Array.from(rows[2].column_indices, Number)).toEqual([0, 1]);
    });
});
