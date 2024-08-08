import * as proto from '../gen/sqlynx/proto/index.js';

export function findTableReferencesForTableId(script: proto.AnalyzedScript, dbId: number, schemaId: number, tableId: bigint): [number, number] {
    // Helper to search a lower bound
    const lowerBound = (script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) => {
        while (begin < end) {
            // Find the middle reference
            const m: number = Math.floor((begin + end) / 2);
            const midRef = script.indexedTableReferences(m, tmp);
            // Check the database id
            if (midRef.catalogDatabaseId() == targetDb) {
                // Check the schema id
                if (midRef.catalogSchemaId() == targetSchema) {
                    // Check the table id
                    if (midRef.catalogTableId() == targetTable) {
                        return m;
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
    };
    // Helper to search an upper bound
    const upperBound = (script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) => {
        // XXX
        return end;
    }

    // Is empty?
    let end = script.indexedTableReferencesLength();
    if (end == 0) {
        return [end, end];
    }
    // Find lower bound
    const tmp = new proto.IndexedTableReference();
    const begin = lowerBound(script, tmp, 0, end, dbId, schemaId, tableId);
    // Find upper bound
    end = upperBound(script, tmp, begin, end, dbId, schemaId, tableId);
    return [begin, end];
}
