import * as sqlynx from '@ankoh/sqlynx-core';

import { EdgeType } from './graph_edges.js';

export interface GraphBoundaries {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    totalWidth: number;
    totalHeight: number;
}

interface CatalogNodeViewModel {
    nodeId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    tableCount: number;
    columnCount: number;
    nodePorts: number;
}

export interface CatalogTableColumnViewModel extends CatalogNodeViewModel { }

export interface CatalogTableViewModel extends CatalogNodeViewModel {
    tableId: sqlynx.ExternalObjectID.Value;
    columns: number;
    columnCount: number;
    columnByName: Map<string, number>;
}

export interface CatalogSchemaViewModel extends CatalogNodeViewModel {
    tablesBegin: number;
    tableCount: number;
    tableByName: Map<string, number>;
}

export interface CatalogDatabaseViewModel extends CatalogNodeViewModel {
    schemasBegin: number;
    schemaCount: number;
    schemaByName: Map<string, number>;
}

export interface CatalogQueryEdgeViewModel {
    connectionId: GraphConnectionId.Value;
    queryEdge: Set<sqlynx.ExternalObjectID.Value>;
    columnRefs: Set<sqlynx.ExternalObjectID.Value>;
    fromTableNodeId: number;
    fromTableNodePort: number;
    toTableNodeId: number;
    toTableNodePort: number;
    edgeType: EdgeType;
    svgPath: string;
    laneId: number;
}

export enum AttentionFlags {
    Suggested = 0b1,
    Related = 0b10,
    Peeked = 0b100,
    ScriptFocus = 0b1000,
    CatalogFocus = 0b10000,
}

export interface CatalogFocusViewModel {
    databases: Map<number, AttentionFlags>;
    schemas: Map<number, AttentionFlags>;
    tables: Map<number, AttentionFlags>;
    columns: Map<number, AttentionFlags>;
}

export interface CatalogViewModel {
    databases: CatalogDatabaseViewModel[];
    schemas: CatalogSchemaViewModel[];
    tables: CatalogTableViewModel[];
    columns: CatalogTableColumnViewModel[];
    boundaries: GraphBoundaries;

    databaseByName: Map<string, number>;
    tableByObject: Map<sqlynx.ExternalObjectID.Value, number>;
    queryEdges: Map<GraphConnectionId.Value, CatalogQueryEdgeViewModel>;

    focus: CatalogFocusViewModel;
}

export namespace GraphConnectionId {
    export type Value = bigint;
    export function create(from: number, to: number): Value {
        return (BigInt(from) << 32n) | BigInt(to);
    }
    export function unpack(id: Value): [number, number] {
        const from = id >> 32n;
        const to = id & ((1n << 32n) - 1n);
        return [Number(from), Number(to)];
    }
}

interface ColumnState {
    name: string;
}

interface TableState {
    name: string;
    columns: ColumnState[];
}

interface SchemaState {
    name: string;
    tables: TableState[];
}

interface DatabaseState {
    name: string;
    schemas: SchemaState[];
    schemasByName: Map<string, SchemaState>;
}

export function computeCatalogViewModel(catalog: sqlynx.SQLynxCatalog): CatalogViewModel {
    const boundaries: GraphBoundaries = {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        totalWidth: 0,
        totalHeight: 0,
    };

    /// Describe all entries in the catalog
    const entriesPtr = catalog.describeEntries();
    const entriesReader = entriesPtr.read(new sqlynx.proto.CatalogEntries());
    const databases: DatabaseState[] = [];
    const databaseByName = new Map<string, DatabaseState>();

    // Read all catalog entries
    const tmpEntry = new sqlynx.proto.CatalogEntry();
    const tmpSchema = new sqlynx.proto.SchemaDescriptor();
    const tmpTable = new sqlynx.proto.SchemaTable();
    const tmpColumn = new sqlynx.proto.SchemaTableColumn();
    for (let entryId = 0; entryId < entriesReader.entriesLength(); ++entryId) {
        const entryPtr = entriesReader.entries(entryId, tmpEntry)!;
        for (let schemaId = 0; schemaId < entryPtr.schemasLength(); ++schemaId) {
            const schemaPtr = entryPtr.schemas(schemaId, tmpSchema)!;
            const databaseName = schemaPtr.databaseName()!;
            const schemaName = schemaPtr.schemaName()!;

            // Resolve database state
            let databaseState: DatabaseState | undefined = databaseByName.get(databaseName);
            if (databaseState === undefined) {
                databaseState = {
                    name: databaseName,
                    schemas: [],
                    schemasByName: new Map()
                };
                databases.push(databaseState);
                databaseByName.set(databaseState.name, databaseState);
            }

            // Resolve schema state
            let schemaState: SchemaState | undefined = databaseState.schemasByName.get(schemaName);
            if (schemaState === undefined) {
                schemaState = {
                    name: schemaName,
                    tables: []
                };
                databaseState.schemas.push(schemaState);
                databaseState.schemasByName.set(schemaState.name, schemaState);
            }

            // Collect tables
            for (let tableId = 0; tableId < schemaPtr.tablesLength(); ++tableId) {
                const tablePtr = schemaPtr.tables(schemaId, tmpTable)!;
                const tableName = tablePtr.tableName()!;
                const tableState: TableState = {
                    name: tableName,
                    columns: []
                };
                for (let columnId = 0; columnId < tablePtr.columnsLength(); ++columnId) {
                    const columnPtr = tablePtr.columns(schemaId, tmpColumn)!;
                    const columnName = columnPtr.columnName()!;

                    tableState.columns.push({
                        name: columnName
                    });
                }
                schemaState.tables.push(tableState);
            }
        }
    }

    const out: CatalogViewModel = {
        databases: [],
        schemas: [],
        tables: [],
        columns: [],

        databaseByName: new Map<string, number>(),
        tableByObject: new Map<sqlynx.ExternalObjectID.Value, number>(),
        queryEdges: new Map<GraphConnectionId.Value, CatalogQueryEdgeViewModel>(),

        focus: {
            databases: new Map(),
            schemas: new Map(),
            tables: new Map(),
            columns: new Map(),
        },

        boundaries,
    };

    const nextNodeId = 0;
    const nextY = 0;
    const WIDTH_DATABASE = 0;
    const HEIGHT_DATABASE = 0;

    for (const database of databases) {
        const schemasBegin = out.schemas.length;
        const schemaByName = new Map<string, number>();
        let tableCount = 0;
        let columnCount = 0;

        // XXX Collect schemas

        out.databases.push({
            nodeId: nextNodeId,
            x: 0,
            y: nextY,
            width: WIDTH_DATABASE,
            height: HEIGHT_DATABASE,
            name: database.name,
            tableCount,
            columnCount,
            nodePorts: 0,

            schemasBegin,
            schemaCount: out.schemas.length,
            schemaByName
        });
    }

    return {
        databases: [],
        schemas: [],
        tables: [],
        columns: [],

        databaseByName: new Map<string, number>(),
        tableByObject: new Map<sqlynx.ExternalObjectID.Value, number>(),
        queryEdges: new Map<GraphConnectionId.Value, CatalogQueryEdgeViewModel>(),

        focus: {
            databases: new Map(),
            schemas: new Map(),
            tables: new Map(),
            columns: new Map(),
        },

        boundaries,
    };
}
