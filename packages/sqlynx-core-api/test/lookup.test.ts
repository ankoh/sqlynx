import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as flatbuffers from 'flatbuffers';

function tableRef(db: number, schema: number, table: bigint, refId: number) {
    return new sqlynx.proto.IndexedTableReferenceT(db, schema, table, refId);
}
function columnRef(db: number, schema: number, table: bigint, column: number, refId: number) {
    return new sqlynx.proto.IndexedColumnReferenceT(db, schema, table, column, refId);
}
function packScript(tableRefs: sqlynx.proto.IndexedTableReferenceT[], columnRefs: sqlynx.proto.IndexedColumnReferenceT[]) {
    const script = new sqlynx.proto.AnalyzedScriptT(0, [], [], [], [], [], tableRefs, columnRefs);
    const builder = new flatbuffers.Builder();
    const ofs = script.pack(builder);
    builder.finish(ofs);
    const buffer = builder.dataBuffer();
    return sqlynx.proto.AnalyzedScript.getRootAsAnalyzedScript(buffer);
}

const DB_ID = 123;
const SCHEMA_ID = 456;

describe('Lookup', () => {

    describe('table refs', () => {
        describe('lower bound', () => {
            it('empty', () => {
                const script = packScript([], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, 0, 0, 0, 0n);
                expect(iter).toEqual(0);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID, 0n);
                expect(iter).toEqual(0);
            });
            it('single miss', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID + 1, 0n);
                expect(iter).toEqual(1);
            });
            it('skip 1', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 2), 0),
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, 2, DB_ID, SCHEMA_ID, 0n);
                expect(iter).toEqual(1);
            });
            it('100 different, last', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, i), 0));
                }
                tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 1), 0))
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 0));
                expect(iter).toEqual(100);
            });
            it('100 different, first', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 1), 0))
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, i), 0));
                }
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 0));
                expect(iter).toEqual(0);
            });
            it('100 different, mid', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 50; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, i), 0));
                }
                tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 1), 0))
                for (let i = 0; i < 50; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(44, i), 0));
                }
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 0));
                expect(iter).toEqual(50);
            });
            it('100 equal, skip first', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 2), 0))
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 3));
                expect(iter).toEqual(1);
            });
            it('100 equal, skip 100', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 4), i))
                }
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 3));
                expect(iter).toEqual(100);
            });
        });

        describe('upper bound', () => {
            it('empty', () => {
                const script = packScript([], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsUpperBound(script, tmp, 0, 0, 0, 0, 0n);
                expect(iter).toEqual(0);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsUpperBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID - 1, 0n);
                expect(iter).toEqual(0);
            });
            it('single miss', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsUpperBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual(1);
            });
            it('skip 1', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2), 0),
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsUpperBound(script, tmp, 0, 2, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2));
                expect(iter).toEqual(1);
            });
            it('100 equal, skip 100', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 4), i))
                }
                const script = packScript(tableRefs, []);
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.tableRefsUpperBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual(200);
            });
        });

        describe('equal range', () => {
            it('empty', () => {
                const script = packScript([], [])
                const iter = sqlynx.tableRefsEqualRange(script, 0, 0, 0n);
                expect(iter).toEqual([0, 0]);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([0, 1]);
            });
            it('single miss, lower', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([0, 0]);
            });
            it('single miss, upper', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID + 1, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([1, 1]);
            });
            it('100 equal, skip 100', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 4), i))
                }
                const script = packScript(tableRefs, []);
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([100, 200]);
            });
            it('100 equal, skip 200', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 200; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 4), i))
                }
                const script = packScript(tableRefs, []);
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([200, 300]);
            });
            it('100 equal, skip 200, trailing 400', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 200; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 400; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 4), i))
                }
                const script = packScript(tableRefs, []);
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([200, 300]);
            });
            it('100 equal, skip 200, trailing 400, schema prefix', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 200; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(41, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 400; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID + 1, sqlynx.ExternalObjectID.create(43, 4), i))
                }
                const script = packScript(tableRefs, []);
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID, SCHEMA_ID);
                expect(iter).toEqual([200, 300]);
            });
            it('100 equal, skip 200, trailing 400, db prefix', () => {
                const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
                for (let i = 0; i < 200; ++i) {
                    tableRefs.push(tableRef(DB_ID - 1, 0, sqlynx.ExternalObjectID.create(41, 2), i))
                }
                for (let i = 0; i < 100; ++i) {
                    tableRefs.push(tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), i));
                }
                for (let i = 0; i < 400; ++i) {
                    tableRefs.push(tableRef(DB_ID + 1, 0, sqlynx.ExternalObjectID.create(43, 4), i))
                }
                const script = packScript(tableRefs, []);
                const iter = sqlynx.tableRefsEqualRange(script, DB_ID);
                expect(iter).toEqual([200, 300]);
            });
        });
    });

    describe('column refs', () => {
        describe('equal range', () => {
            it('empty', () => {
                const script = packScript([], [])
                const iter = sqlynx.columnRefsEqualRange(script, 0, 0, 0n, 0);
                expect(iter).toEqual([0, 0]);
            });
            it('single hit', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ]);
                const iter = sqlynx.columnRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([0, 1]);
            });
            it('single miss, lower', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ])
                const iter = sqlynx.columnRefsEqualRange(script, DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([0, 0]);
            });
            it('single miss, upper', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ])
                const iter = sqlynx.columnRefsEqualRange(script, DB_ID, SCHEMA_ID + 1, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([1, 1]);
            });
        });


    });
});
