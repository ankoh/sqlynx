import * as proto from '../gen/sqlynx/proto/index.js';

/// Find lower bound among table refs for a table
export function findScriptTableRefsLowerBound(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.tableReferencesById(m, tmp);
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
export function findScriptTableRefsUpperBound(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.tableReferencesById(m, tmp);
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
export function findScriptTableRefsEqualRange(script: proto.AnalyzedScript, targetDb: number, targetSchema: number | null = null, targetTable: bigint | null = null, tmp: proto.IndexedTableReference = new proto.IndexedTableReference()): [number, number] {
    const begin = 0;
    const end = script.tableReferencesByIdLength();
    const lb = findScriptTableRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema ?? 0, targetTable ?? 0n);
    const ub = findScriptTableRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema ?? Number.MAX_SAFE_INTEGER, targetTable ?? 0xFFFFFFFFFFFFFFFFn);
    return [lb, ub];
}

/// Find lower bound among column refs for a table
export function findScriptColumnRefsLowerBound(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.columnReferencesById(m, tmp);
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
export function findScriptColumnRefsUpperBound(script: proto.AnalyzedScript, tmp: proto.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.columnReferencesById(m, tmp);
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
export function findScriptColumnRefsEqualRange(script: proto.AnalyzedScript, targetDb: number, targetSchema: number | null = null, targetTable: bigint | null = null, columnId: number | null = null, tmp: proto.IndexedColumnReference = new proto.IndexedColumnReference()): [number, number] {
    const begin = 0;
    const end = script.columnReferencesByIdLength();
    const lb = findScriptColumnRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema ?? 0, targetTable ?? 0n, columnId ?? 0);
    const ub = findScriptColumnRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema ?? Number.MAX_SAFE_INTEGER, targetTable ?? 0xFFFFFFFFFFFFFFFFn, columnId ?? Number.MAX_SAFE_INTEGER);
    return [lb, ub];
}


/// Find table by id
export function findCatalogDatabaseById(catalog: proto.FlatCatalog, databaseId: number, tmp: proto.IndexedFlatDatabaseEntry = new proto.IndexedFlatDatabaseEntry()) {
    let begin = 0;
    let end = catalog.databasesByIdLength();

    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = catalog.databasesById(m, tmp);
        // Check the database id
        if (midRef.databaseId() == databaseId) {
            return midRef.flatEntryIdx();
        } else if (midRef.databaseId() < databaseId) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return null;
}
