import * as proto from '../gen/sqlynx/proto/index.js';

// Find table ref lower bound for table id
export function lowerBoundTableRefs(script: proto.AnalyzedScript, tmp: proto.IndexedTableReference, begin: number, end: number, targetDb: number, targetSchema: number, targetTable: bigint) {
    while (begin < end) {
        // Find the middle reference
        const m: number = begin + ((end - begin) >> 1);
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
}
