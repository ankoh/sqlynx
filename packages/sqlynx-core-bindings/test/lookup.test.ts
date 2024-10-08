import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as flatbuffers from 'flatbuffers';

function tableRef(db: number, schema: number, table: bigint, refId: number) {
    return new sqlynx.proto.IndexedTableReferenceT(db, schema, table, refId);
}
function columnRef(db: number, schema: number, table: bigint, column: number, refId: number) {
    return new sqlynx.proto.IndexedColumnReferenceT(db, schema, table, column, refId);
}
function databaseEntryById(db: number, index: number) {
    return new sqlynx.proto.IndexedFlatDatabaseEntryT(db, index);
}
function schemaEntryById(schema: number, index: number) {
    return new sqlynx.proto.IndexedFlatSchemaEntryT(schema, index);
}
function tableEntryById(table: bigint, index: number) {
    return new sqlynx.proto.IndexedFlatTableEntryT(table, index);
}

function packScript(tableRefs: sqlynx.proto.IndexedTableReferenceT[], columnRefs: sqlynx.proto.IndexedColumnReferenceT[]) {
    const script = new sqlynx.proto.AnalyzedScriptT();
    script.tableReferencesById = tableRefs;
    script.columnReferencesById = columnRefs;
    const builder = new flatbuffers.Builder();
    const ofs = script.pack(builder);
    builder.finish(ofs);
    const buffer = builder.dataBuffer();
    return sqlynx.proto.AnalyzedScript.getRootAsAnalyzedScript(buffer);
}
function packCatalog(databasesById: sqlynx.proto.IndexedFlatDatabaseEntryT[], schemasById: sqlynx.proto.IndexedFlatSchemaEntryT[], tablesById: sqlynx.proto.IndexedFlatTableEntryT[]) {
    const script = new sqlynx.proto.FlatCatalogT();
    script.databasesById = databasesById;
    script.schemasById = schemasById;
    script.tablesById = tablesById;
    const builder = new flatbuffers.Builder();
    const ofs = script.pack(builder);
    builder.finish(ofs);
    const buffer = builder.dataBuffer();
    return sqlynx.proto.FlatCatalog.getRootAsFlatCatalog(buffer);
}

const DB_ID = 123;
const SCHEMA_ID = 456;

describe('Lookup', () => {

    describe('script table refs', () => {
        describe('lower bound', () => {
            it('empty', () => {
                const script = packScript([], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, 0, 0, 0, 0n);
                expect(iter).toEqual(0);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID, 0n);
                expect(iter).toEqual(0);
            });
            it('single miss', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID + 1, 0n);
                expect(iter).toEqual(1);
            });
            it('skip 1', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 2), 0),
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, 2, DB_ID, SCHEMA_ID, 0n);
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
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 0));
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
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 0));
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
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(43, 0));
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
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 3));
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
                const iter = sqlynx.findScriptTableRefsLowerBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(41, 3));
                expect(iter).toEqual(100);
            });
        });

        describe('upper bound', () => {
            it('empty', () => {
                const script = packScript([], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsUpperBound(script, tmp, 0, 0, 0, 0, 0n);
                expect(iter).toEqual(0);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsUpperBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID - 1, 0n);
                expect(iter).toEqual(0);
            });
            it('single miss', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsUpperBound(script, tmp, 0, 1, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual(1);
            });
            it('skip 1', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2), 0),
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const tmp = new sqlynx.proto.IndexedTableReference();
                const iter = sqlynx.findScriptTableRefsUpperBound(script, tmp, 0, 2, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 2));
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
                const iter = sqlynx.findScriptTableRefsUpperBound(script, tmp, 0, tableRefs.length, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual(200);
            });
        });

        describe('equal range', () => {
            it('empty', () => {
                const script = packScript([], [])
                const iter = sqlynx.findScriptTableRefsEqualRange(script, 0, 0, 0n);
                expect(iter).toEqual([0, 0]);
            });
            it('single hit', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([0, 1]);
            });
            it('single miss, lower', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 3));
                expect(iter).toEqual([0, 0]);
            });
            it('single miss, upper', () => {
                const script = packScript([
                    tableRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0)
                ], [])
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID + 1, sqlynx.ExternalObjectID.create(42, 3));
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
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
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
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
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
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3));
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
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID, SCHEMA_ID);
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
                const iter = sqlynx.findScriptTableRefsEqualRange(script, DB_ID);
                expect(iter).toEqual([200, 300]);
            });
        });
    });

    describe('script column refs', () => {
        describe('equal range', () => {
            it('empty', () => {
                const script = packScript([], [])
                const iter = sqlynx.findScriptColumnRefsEqualRange(script, 0, 0, 0n, 0);
                expect(iter).toEqual([0, 0]);
            });
            it('single hit', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ]);
                const iter = sqlynx.findScriptColumnRefsEqualRange(script, DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([0, 1]);
            });
            it('single miss, lower', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ])
                const iter = sqlynx.findScriptColumnRefsEqualRange(script, DB_ID, SCHEMA_ID - 1, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([0, 0]);
            });
            it('single miss, upper', () => {
                const script = packScript([], [
                    columnRef(DB_ID, SCHEMA_ID, sqlynx.ExternalObjectID.create(42, 3), 0, 0)
                ])
                const iter = sqlynx.findScriptColumnRefsEqualRange(script, DB_ID, SCHEMA_ID + 1, sqlynx.ExternalObjectID.create(42, 3), 0);
                expect(iter).toEqual([1, 1]);
            });
        });
    });

    describe('catalog database ids', () => {
        it('empty', () => {
            const catalog = packCatalog([], [], [])
            const iter = sqlynx.findCatalogDatabaseById(catalog, 0);
            expect(iter).toEqual(null);
        });
        it('single hit', () => {
            const catalog = packCatalog([
                databaseEntryById(42, 0)
            ], [], [])
            const iter = sqlynx.findCatalogDatabaseById(catalog, 42);
            expect(iter).toEqual(0);
        });
        it('single miss', () => {
            const catalog = packCatalog([
                databaseEntryById(42, 0)
            ], [], [])
            const iter = sqlynx.findCatalogDatabaseById(catalog, 21);
            expect(iter).toEqual(null);
        });
        it('skip 100, 200 trailing', () => {
            const databases: sqlynx.proto.IndexedFlatDatabaseEntryT[] = [];
            let nextDb = 222;
            let nextIdx = 0;
            for (let i = 0; i < 100; ++i) {
                databases.push(databaseEntryById(nextDb++, nextIdx++));
            }
            databases.push(databaseEntryById(nextDb++, nextIdx++));
            for (let i = 0; i < 200; ++i) {
                databases.push(databaseEntryById(nextDb++, nextIdx++));
            }
            const catalog = packCatalog(databases, [], []);
            const iter = sqlynx.findCatalogDatabaseById(catalog, 322);
            expect(iter).toEqual(100);
        });
    });

    describe('catalog schema ids', () => {
        it('empty', () => {
            const catalog = packCatalog([], [], [])
            const iter = sqlynx.findCatalogDatabaseById(catalog, 0);
            expect(iter).toEqual(null);
        });
        it('single hit', () => {
            const catalog = packCatalog([], [
                schemaEntryById(42, 0)
            ], [])
            const iter = sqlynx.findCatalogSchemaById(catalog, 42);
            expect(iter).toEqual(0);
        });
        it('single miss', () => {
            const catalog = packCatalog([], [
                schemaEntryById(42, 0)
            ], [])
            const iter = sqlynx.findCatalogSchemaById(catalog, 21);
            expect(iter).toEqual(null);
        });
        it('skip 100, 200 trailing', () => {
            const schemas: sqlynx.proto.IndexedFlatSchemaEntryT[] = [];
            let nextDb = 2222;
            let nextIdx = 0;
            for (let i = 0; i < 100; ++i) {
                schemas.push(schemaEntryById(nextDb++, nextIdx++));
            }
            schemas.push(schemaEntryById(nextDb++, nextIdx++));
            for (let i = 0; i < 200; ++i) {
                schemas.push(schemaEntryById(nextDb++, nextIdx++));
            }
            const catalog = packCatalog([], schemas, []);
            const iter = sqlynx.findCatalogSchemaById(catalog, 2322);
            expect(iter).toEqual(100);
        });
    });

    describe('catalog table ids', () => {
        it('empty', () => {
            const catalog = packCatalog([], [], [])
            const iter = sqlynx.findCatalogDatabaseById(catalog, 0);
            expect(iter).toEqual(null);
        });
        it('single hit', () => {
            const catalog = packCatalog([], [], [
                tableEntryById(sqlynx.ExternalObjectID.create(42, 43), 0)
            ])
            const iter = sqlynx.findCatalogTableById(catalog, sqlynx.ExternalObjectID.create(42, 43));
            expect(iter).toEqual(0);
        });
        it('single miss', () => {
            const catalog = packCatalog([], [], [
                tableEntryById(sqlynx.ExternalObjectID.create(42, 43), 0)
            ])
            const iter = sqlynx.findCatalogTableById(catalog, sqlynx.ExternalObjectID.create(42, 44));
            expect(iter).toEqual(null);
        });
    });
});
