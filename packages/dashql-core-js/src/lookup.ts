import * as buffers from './buffers.js';

/// Find lower bound among table refs for a table
export function findScriptTableRefsLowerBound(script: buffers.analyzer.AnalyzedScript, tmp: buffers.analyzer.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.resolvedTableReferencesById(m, tmp);
        if (midRef == null) {
            return end;
        }
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
export function findScriptTableRefsUpperBound(script: buffers.analyzer.AnalyzedScript, tmp: buffers.analyzer.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.resolvedTableReferencesById(m, tmp);
        if (midRef == null) {
            return end;
        }
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
export function findScriptTableRefsEqualRange(script: buffers.analyzer.AnalyzedScript, targetDb: number, targetSchema: number | null = null, targetTable: bigint | null = null, tmp: buffers.analyzer.IndexedTableReference = new buffers.analyzer.IndexedTableReference()): [number, number] {
    const begin = 0;
    const end = script.resolvedTableReferencesByIdLength();
    const lb = findScriptTableRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema ?? 0, targetTable ?? 0n);
    const ub = findScriptTableRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema ?? Number.MAX_SAFE_INTEGER, targetTable ?? 0xFFFFFFFFFFFFFFFFn);
    return [lb, ub];
}

/// Find lower bound among column refs for a table
export function findScriptColumnRefsLowerBound(script: buffers.analyzer.AnalyzedScript, tmp: buffers.analyzer.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.resolvedColumnReferencesById(m, tmp);
        if (midRef == null) {
            return end;
        }
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
export function findScriptColumnRefsUpperBound(script: buffers.analyzer.AnalyzedScript, tmp: buffers.analyzer.IndexedColumnReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint, columnId: number) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
        const midRef = script.resolvedColumnReferencesById(m, tmp);
        if (midRef == null) {
            return end;
        }
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
export function findScriptColumnRefsEqualRange(script: buffers.analyzer.AnalyzedScript, targetDb: number, targetSchema: number | null = null, targetTable: bigint | null = null, columnId: number | null = null, tmp: buffers.analyzer.IndexedColumnReference = new buffers.analyzer.IndexedColumnReference()): [number, number] {
    const begin = 0;
    const end = script.resolvedColumnReferencesByIdLength();
    const lb = findScriptColumnRefsLowerBound(script, tmp, begin, end, targetDb, targetSchema ?? 0, targetTable ?? 0n, columnId ?? 0);
    const ub = findScriptColumnRefsUpperBound(script, tmp, lb, end, targetDb, targetSchema ?? Number.MAX_SAFE_INTEGER, targetTable ?? 0xFFFFFFFFFFFFFFFFn, columnId ?? Number.MAX_SAFE_INTEGER);
    return [lb, ub];
}


/// Find database by id
export function findCatalogDatabaseById(catalog: buffers.catalog.FlatCatalog, databaseId: number, tmp: buffers.catalog.IndexedFlatDatabaseEntry = new buffers.catalog.IndexedFlatDatabaseEntry()): number | null {
    let begin = 0;
    let end = catalog.databasesByIdLength();
    while (begin < end) {
        const m: number = begin + ((end - begin) >> 1);
        const midRef = catalog.databasesById(m, tmp);
        if (midRef == null) {
            return null;
        }
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

/// Find schema by id
export function findCatalogSchemaById(catalog: buffers.catalog.FlatCatalog, schemaId: number, tmp: buffers.catalog.IndexedFlatSchemaEntry = new buffers.catalog.IndexedFlatSchemaEntry()): number | null {
    let begin = 0;
    let end = catalog.schemasByIdLength();
    while (begin < end) {
        const m: number = begin + ((end - begin) >> 1);
        const midRef = catalog.schemasById(m, tmp);
        if (midRef == null) {
            return null;
        }
        if (midRef.schemaId() == schemaId) {
            return midRef.flatEntryIdx();
        } else if (midRef.schemaId() < schemaId) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return null;
}

/// Find table by id
export function findCatalogTableById(catalog: buffers.catalog.FlatCatalog, tableId: bigint, tmp: buffers.catalog.IndexedFlatTableEntry = new buffers.catalog.IndexedFlatTableEntry()): number | null {
    let begin = 0;
    let end = catalog.tablesByIdLength();
    while (begin < end) {
        const m: number = begin + ((end - begin) >> 1);
        const midRef = catalog.tablesById(m, tmp);
        if (midRef == null) {
            return null;
        }
        if (midRef.tableId() == tableId) {
            return midRef.flatEntryIdx();
        } else if (midRef.tableId() < tableId) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return null;
}
