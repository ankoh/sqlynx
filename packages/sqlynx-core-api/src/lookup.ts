import * as proto from '../gen/sqlynx/proto/index.js';

/// Find lower bound among table refs for a table
export function tableRefsLowerBound(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.indexedTableReferences(m, tmp);
        // Check the database id
        if (midRef.catalogDatabaseId() == targetDb) {
            // Check the schema id
            if (midRef.catalogSchemaId() == targetSchema) {
                // Check the table id
                if (midRef.catalogTableId() < targetTable) {
                    begin = m + 1;
                } else {
                    end = m;
                }
            } else if (midRef.catalogSchemaId() < targetSchema) {
                begin = m + 1;
            } else {
                end = m;
            }
        } else if (midRef.catalogDatabaseId() < targetDb) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return end;
}

/// Find upper bound among table refs for a table
export function tableRefsUpperBound(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.indexedTableReferences(m, tmp);
        // Check the database id
        if (midRef.catalogDatabaseId() == targetDb) {
            // Check the schema id
            if (midRef.catalogSchemaId() == targetSchema) {
                // Check the table id
                if (midRef.catalogTableId() <= targetTable) {
                    begin = m + 1;
                } else {
                    end = m;
                }
            } else if (midRef.catalogSchemaId() < targetSchema) {
                begin = m + 1;
            } else {
                end = m;
            }
        } else if (midRef.catalogDatabaseId() < targetDb) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return end;
}

/// Find equal range among table refs for a table
export function tableRefsEqualRange(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint): [number, number] {
    const lb = tableRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema, targetTable);
    const ub = tableRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema, targetTable);
    return [lb, ub];
}
/// Find equal range among table refs for a schema
export function tableRefsEqualRangeBySchema(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number): [number, number] {
    const lb = tableRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema, 0n);
    const ub = tableRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema, 0xFFFFFFFFFFFFFFFFn);
    return [lb, ub];
}
/// Find equal range among table refs for a database
export function tableRefsEqualRangeByDatabase(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number): [number, number] {
    const lb = tableRefsLowerBound(script, tmp, begin, end, targetDb, 0, 0n);
    const ub = tableRefsUpperBound(script, tmp, lb, end, targetDb, Number.MAX_SAFE_INTEGER, 0xFFFFFFFFFFFFFFFFn);
    return [lb, ub];
}

/// Find lower bound among column refs for a table
export function columnRefsLowerBound(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.indexedColumnReferences(m, tmp);
        // Check the database id
        if (midRef.catalogDatabaseId() == targetDb) {
            // Check the schema id
            if (midRef.catalogSchemaId() == targetSchema) {
                // Check the table id
                if (midRef.catalogTableId() == targetTable) {
                    // Check the column id
                    if (midRef.tableColumnId() < columnId) {
                        begin = m + 1;
                    } else {
                        end = m;
                    }
                } else if (midRef.catalogTableId() < targetTable) {
                    begin = m + 1;
                } else {
                    end = m;
                }
            } else if (midRef.catalogSchemaId() < targetSchema) {
                begin = m + 1;
            } else {
                end = m;
            }
        } else if (midRef.catalogDatabaseId() < targetDb) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return end;
}

/// Find upper bound among column refs for a table
export function columnRefsUpperBound(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.indexedColumnReferences(m, tmp);
        // Check the database id
        if (midRef.catalogDatabaseId() == targetDb) {
            // Check the schema id
            if (midRef.catalogSchemaId() == targetSchema) {
                // Check the table id
                if (midRef.catalogTableId() == targetTable) {
                    // Check the column id
                    if (midRef.tableColumnId() <= columnId) {
                        begin = m + 1;
                    } else {
                        end = m;
                    }
                } else if (midRef.catalogTableId() < targetTable) {
                    begin = m + 1;
                } else {
                    end = m;
                }
            } else if (midRef.catalogSchemaId() < targetSchema) {
                begin = m + 1;
            } else {
                end = m;
            }
        } else if (midRef.catalogDatabaseId() < targetDb) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return end;
}

/// Find equal range among table refs for a table column
export function columnRefsEqualRange(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number): [number, number] {
    const lb = columnRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema, targetTable, columnId);
    const ub = columnRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema, targetTable, columnId);
    return [lb, ub];
}

/// Find equal range among table refs for a table
export function columnRefsEqualRangeByTable(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint): [number, number] {
    const lb = columnRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema, targetTable, 0);
    const ub = columnRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema, targetTable, Number.MAX_SAFE_INTEGER);
    return [lb, ub];
}
/// Find equal range among table refs for a schema
export function columnRefsEqualRangeBySchema(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number): [number, number] {
    const lb = columnRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema, 0n, 0);
    const ub = columnRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema, 0xFFFFFFFFFFFFFFFFn, Number.MAX_SAFE_INTEGER);
    return [lb, ub];
}

/// Find equal range among table refs for a database
export function columnRefsEqualRangeByDatabase(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number): [number, number] {
    const lb = columnRefsLowerBound(script, tmp, begin, end, targetDb, 0, 0n, 0);
    const ub = columnRefsUpperBound(script, tmp, lb, end, targetDb, Number.MAX_SAFE_INTEGER, 0xFFFFFFFFFFFFFFFFn, Number.MAX_SAFE_INTEGER);
    return [lb, ub];
}
