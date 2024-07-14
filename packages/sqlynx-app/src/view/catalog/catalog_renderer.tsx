import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_renderer.module.css';

import { motion } from "framer-motion";
import { CatalogSnapshot, CatalogSnapshotReader } from '../../connectors/catalog_snapshot.js';

/// The settings for rendering the catalog
export interface CatalogRenderingSettings {
    /// The width of a database node
    widthDatabase: number;
    /// The width of a schema node
    widthSchema: number;
    /// The width of a table node
    widthTable: number;
    /// The width of a column node
    widthColumn: number;
    /// The height of a database node
    heightDatabase: number;
    /// The height of a schema node
    heightSchema: number;
    /// The height of a table node
    heightTable: number;
    /// The height of a column node
    heightColumn: number;

    /// The maximum number of schemas that we show per database
    maxSchemasPerDatabase: number;
    /// The maximum number of table that we show per schema
    maxTablesPerSchema: number;
    /// The maximum number of columns that we show per table
    maxColumnsPerTable: number;

    /// The row gap when starting a new database
    rowGapDatabase: number;
    /// The row gap when starting a new schema
    rowGapSchema: number;
    /// The row gap when starting a new table
    rowGapTable: number;
    /// The row gap when starting a new table
    rowGapColumn: number;

    /// The column gap left of schema
    columnGapSchema: number;
    /// The column gap left of table
    columnGapTable: number;
    /// The column gap left of column
    columnGapColumn: number;
}

/// The node rendering mode
enum NodeVariant {
    DEFAULT = 0,
    OVERRIDE = 1,
    OVERFLOW = 2,
    FOCUS_CATALOG_DIRECT = 4,
    FOCUS_CATALOG_INDIRECT = 5,
    FOCUS_SCRIPT_DIRECT = 6,
    FOCUS_SCRIPT_INDIRECT = 7,
}

/// Helper to get the rendering mode.
/// We reserve 2 bits per entry to specify the rendering mode.
/// Either the node is rendered as usual, the node is part of an override or the node is overflowing limits.
function getVariant(modes: Uint8Array, index: number): NodeVariant {
    const shift = (index & 0b1) << 2;
    return (modes[index >> 1] >> shift) as NodeVariant;
}
/// Helper to set the rendering mode.
function setRenderingTag(modes: Uint8Array, index: number, node: NodeVariant) {
    const shift = (index & 0b1) << 2;
    const mask = 0b11 << shift;
    const value = node << shift;
    const entry = modes[index >> 1];
    modes[index >> 1] = (entry & mask) | value;
}

class RenderingOverride {
    /// The id in the backing FlatBuffer
    elementId: number;
    /// When rendering this node, what's the height of this subtree?
    renderingHeight: number;
    /// The child overrides
    childOverrides: RenderingOverride[];

    constructor(elementId: number) {
        this.elementId = elementId;
        this.renderingHeight = 0;
        this.childOverrides = [];
    }
}

/// A rendering stack
class CatalogRenderingStack {
    /// The database id
    public databaseId: number | null;
    /// The schema id
    public schemaId: number | null;
    /// The table id
    public tableId: number | null;
    /// The column id
    public columnId: number | null;

    /// The database id string
    private databaseIdString: string | null;
    /// The schema id string
    private schemaIdString: string | null;
    /// The table id string
    private tableIdString: string | null;
    /// The table id string
    private columnIdString: string | null;

    /// The first database id?
    public firstDatabase: boolean;
    /// The first database id?
    public firstSchema: boolean;
    /// The first database id?
    public firstTable: boolean;
    /// The first database id?
    public firstColumn: boolean;

    constructor() {
        this.databaseId = null;
        this.databaseIdString = null;
        this.schemaId = null;
        this.schemaIdString = null;
        this.tableId = null;
        this.tableIdString = null;
        this.columnId = null;
        this.columnIdString = null;
        this.firstDatabase = true;
        this.firstSchema = true;
        this.firstTable = true;
        this.firstColumn = true;
    }
    public selectDatabase(id: number) {
        this.firstDatabase = this.databaseId == null;
        this.databaseId = id;
        this.databaseIdString = null;
        this.schemaId = null;
        this.schemaIdString = null;
        this.tableId = null;
        this.tableIdString = null;
        this.columnId = null;
        this.columnIdString = null;
    }
    public selectSchema(id: number) {
        this.firstSchema = this.schemaId == null;
        this.schemaId = id;
        this.schemaIdString = null;
        this.tableId = null;
        this.tableIdString = null;
        this.columnId = null;
        this.columnIdString = null;
    }
    public selectTable(id: number) {
        this.firstColumn = this.tableId == null;
        this.tableId = id;
        this.tableIdString = null;
        this.columnId = null;
        this.columnIdString = null;
    }
    public selectColumn(id: number) {
        this.firstColumn = this.columnId == null;
        this.columnId = id;
        this.columnIdString = null;
    }
    public getDatabaseIdString(): string {
        if (this.databaseIdString == null) {
            this.databaseIdString = this.databaseId!.toString();
        }
        return this.databaseIdString;
    }
    public getSchemaIdString(): string {
        if (this.schemaIdString == null) {
            this.schemaIdString = this.schemaId!.toString();
        }
        return this.schemaIdString;
    }
    public getTableIdString(): string {
        if (this.tableIdString == null) {
            this.tableIdString = this.tableId!.toString();
        }
        return this.tableIdString;
    }
    public getColumnIdString(): string {
        if (this.columnIdString == null) {
            this.columnIdString = this.columnId!.toString();
        }
        return this.columnIdString;
    }
    public getDatabaseKey() {
        return this.getDatabaseIdString();
    }
    public getSchemaKey() {
        return `${this.getDatabaseIdString()}-${this.getSchemaIdString()}`;
    }
    public getTableKey() {
        return `${this.getDatabaseIdString()}-${this.getSchemaIdString()}-${this.getTableIdString()}`;
    }
    public getColumnKey() {
        return `${this.getDatabaseIdString()}-${this.getSchemaIdString()}-${this.getTableIdString()}-${this.getColumnIdString()}`;
    }
}

/// A catalog rendering state
interface CatalogRenderingState {
    /// The offset of the virtual window
    virtualWindowBegin: number;
    /// The offset of the virtual window
    virtualWindowEnd: number;

    /// Rendering modes for the databases
    databaseVariants: Uint8Array;
    /// Rendering modes for schemas
    schemaVariants: Uint8Array;
    /// Rendering modes for tables
    tableVariants: Uint8Array;
    /// Rendering modes for columns
    columnVariants: Uint8Array;

    /// The hierarchical rendering overrides
    databaseRenderingOverrides: RenderingOverride[];

    /// The database offset
    offsetXDatabases: number;
    /// The schema offset
    offsetXSchema: number;
    /// The table offset
    offsetXTable: number;
    /// The column offset
    offsetXColumn: number;

    /// The current writer
    currentWriterY: number;
    /// The current rendering path
    currentStack: CatalogRenderingStack;

}

interface ScratchFlatBuffers {
    database: sqlynx.proto.FlatCatalogDatabase;
    schema: sqlynx.proto.FlatCatalogSchema;
    table: sqlynx.proto.FlatCatalogTable;
    column: sqlynx.proto.FlatCatalogColumn;
}

function renderColumn(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, column: sqlynx.proto.FlatCatalogColumn, position: number, variant: NodeVariant) {
    // Check the rendering tag
    let nodeStyle: string | null = null;
    switch (variant) {
        case NodeVariant.DEFAULT:
            nodeStyle = styles.column_default;
            break;
        case NodeVariant.FOCUS_CATALOG_INDIRECT:
            nodeStyle = styles.column_focus_catalog_indirect;
            break;
        case NodeVariant.FOCUS_CATALOG_DIRECT:
            nodeStyle = styles.column_focus_catalog_direct;
            break;
        case NodeVariant.FOCUS_SCRIPT_INDIRECT:
            nodeStyle = styles.column_focus_script_indirect;
            break;
        case NodeVariant.FOCUS_SCRIPT_DIRECT:
            nodeStyle = styles.column_focus_script_direct;
            break;
        case NodeVariant.OVERRIDE:
        case NodeVariant.OVERFLOW:
            // Unreachable
            return null;
    }
    // Output column node
    const columnName = snapshot.readName(column.name());
    const columnKey = state.currentStack.getColumnKey();
    return (
        <motion.div
            key={columnKey}
            layoutId={columnKey}
            className={nodeStyle!}
            style={{
                top: position,
                left: state.offsetXColumn,
                width: settings.widthColumn,
                height: settings.heightColumn,
            }}
            data-database={state.currentStack.getDatabaseIdString()}
            data-schema={state.currentStack.getSchemaIdString()}
            data-table={state.currentStack.getTableIdString()}
            data-column={state.currentStack.getColumnIdString()}
        >
            {columnName}
        </motion.div>
    );
}

function renderColumns(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, table: sqlynx.proto.FlatCatalogTable, scratch: ScratchFlatBuffers, out: React.ReactElement[]) {
    for (let c = 0; c < table.columnCount(); ++c) {
        const columnId = table.columnsBegin() + c;
        const column = snapshot.catalogReader.columns(columnId, scratch.column)!;
        const nodeVariant = getVariant(state.columnVariants, columnId);
        const isFirstColumn = state.currentStack.firstColumn;
        state.currentStack.selectColumn(columnId);
        // Add row gap
        state.currentWriterY += isFirstColumn ? 0 : settings.rowGapColumn;
        // Remember own position
        const thisPosY = state.currentWriterY;
        // Bump writer
        state.currentWriterY += settings.heightColumn;
        // Break rendering if over virtual window
        if (thisPosY >= state.virtualWindowEnd) {
            break;
        }
        // Skip if under virtual window
        if (state.currentWriterY < state.virtualWindowBegin) {
            continue;
        }
        out.push(renderColumn(state, settings, snapshot, column, thisPosY, nodeVariant)!);
    }
}

function renderTable(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, column: sqlynx.proto.FlatCatalogTable, position: number, variant: NodeVariant) {
    // Check the rendering tag
    let nodeStyle: string | null = null;
    switch (variant) {
        case NodeVariant.DEFAULT:
            nodeStyle = styles.table_default;
            break;
        case NodeVariant.FOCUS_CATALOG_INDIRECT:
            nodeStyle = styles.table_focus_catalog_indirect;
            break;
        case NodeVariant.FOCUS_CATALOG_DIRECT:
            nodeStyle = styles.table_focus_catalog_direct;
            break;
        case NodeVariant.FOCUS_SCRIPT_INDIRECT:
            nodeStyle = styles.table_focus_script_indirect;
            break;
        case NodeVariant.FOCUS_SCRIPT_DIRECT:
            nodeStyle = styles.table_focus_script_direct;
            break;
        case NodeVariant.OVERRIDE:
        case NodeVariant.OVERFLOW:
            // Unreachable
            return null;
    }
    // Output column node
    const tableName = snapshot.readName(column.name());
    const tableKey = state.currentStack.getTableKey();
    return (
        <motion.div
            key={tableKey}
            layoutId={tableKey}
            className={nodeStyle!}
            style={{
                top: position,
                left: state.offsetXColumn,
                width: settings.widthColumn,
                height: settings.heightColumn,
            }}
            data-database={state.currentStack.getDatabaseIdString()}
            data-schema={state.currentStack.getSchemaIdString()}
            data-table={state.currentStack.getTableIdString()}
        >
            {tableName}
        </motion.div>
    );
}

function renderTables(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, schema: sqlynx.proto.FlatCatalogSchema, scratch: ScratchFlatBuffers, out: React.ReactElement[]) {
    for (let i = 0; i < schema.tableCount(); ++i) {
        // Resolve table
        const tableId = schema.tablesBegin() + i;
        const table = snapshot.catalogReader.tables(tableId, scratch.table)!;
        const nodeVariant = getVariant(state.tableVariants, tableId);
        const isFirstTable = state.currentStack.firstTable;
        state.currentStack.selectTable(tableId);
        // Add row gap
        state.currentWriterY += isFirstTable ? 0 : settings.rowGapTable;
        // Remember own position
        const thisPosY = state.currentWriterY;
        // Render child columns
        renderColumns(state, settings, snapshot, table, scratch, out);
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.heightTable);
        // Break rendering if over virtual window
        if (thisPosY >= state.virtualWindowEnd) {
            break;
        }
        // Skip if under virtual window
        if (state.currentWriterY < state.virtualWindowBegin) {
            continue;
        }
        out.push(renderTable(state, settings, snapshot, table, thisPosY, nodeVariant)!);
    }
}

function renderSchema(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, column: sqlynx.proto.FlatCatalogSchema, position: number, variant: NodeVariant) {
    // Check the rendering tag
    let nodeStyle: string | null = null;
    switch (variant) {
        case NodeVariant.DEFAULT:
            nodeStyle = styles.schema_default;
            break;
        case NodeVariant.FOCUS_CATALOG_INDIRECT:
            nodeStyle = styles.schema_focus_catalog_indirect;
            break;
        case NodeVariant.FOCUS_CATALOG_DIRECT:
            nodeStyle = styles.schema_focus_catalog_direct;
            break;
        case NodeVariant.FOCUS_SCRIPT_INDIRECT:
            nodeStyle = styles.schema_focus_script_indirect;
            break;
        case NodeVariant.FOCUS_SCRIPT_DIRECT:
            nodeStyle = styles.schema_focus_script_direct;
            break;
        case NodeVariant.OVERRIDE:
        case NodeVariant.OVERFLOW:
            // Unreachable
            return null;
    }
    // Output column node
    const schemaName = snapshot.readName(column.name());
    const schemaKey = state.currentStack.getSchemaKey();
    return (
        <motion.div
            key={schemaKey}
            layoutId={schemaKey}
            className={nodeStyle!}
            style={{
                top: position,
                left: state.offsetXColumn,
                width: settings.widthColumn,
                height: settings.heightColumn,
            }}
            data-database={state.currentStack.getDatabaseIdString()}
            data-schema={state.currentStack.getSchemaIdString()}
        >
            {schemaName}
        </motion.div>
    );
}

function renderSchemas(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, database: sqlynx.proto.FlatCatalogDatabase, scratch: ScratchFlatBuffers, out: React.ReactElement[]) {
    for (let i = 0; i < database.schemaCount(); ++i) {
        // Resolve schema
        const schemaId = database.schemasBegin() + i;
        const schema = snapshot.catalogReader.schemas(schemaId, scratch.schema)!;
        const nodeVariant = getVariant(state.schemaVariants, schemaId);
        const isFirstTable = state.currentStack.firstSchema;
        state.currentStack.selectSchema(schemaId);
        // Add gap of schemas
        state.currentWriterY += isFirstTable ? 0 : settings.rowGapSchema;
        // Remember current y position
        const thisPosY = state.currentWriterY;
        // Render child tables
        renderTables(state, settings, snapshot, schema, scratch, out);
        // Bump writer if the tables didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.heightSchema);
        // Break rendering if over virtual window
        if (thisPosY >= state.virtualWindowEnd) {
            break;
        }
        // Skip if under virtual window
        if (state.currentWriterY < state.virtualWindowBegin) {
            continue;
        }
        // Emit schema node
        out.push(renderSchema(state, settings, snapshot, schema, thisPosY, nodeVariant)!);
    }
}

function renderDatabase(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, database: sqlynx.proto.FlatCatalogDatabase, position: number, variant: NodeVariant) {
    // Check the rendering tag
    let nodeStyle: string | null = null;
    switch (variant) {
        case NodeVariant.DEFAULT:
            nodeStyle = styles.database_default;
            break;
        case NodeVariant.FOCUS_CATALOG_INDIRECT:
            nodeStyle = styles.database_focus_catalog_indirect;
            break;
        case NodeVariant.FOCUS_CATALOG_DIRECT:
            nodeStyle = styles.database_focus_catalog_direct;
            break;
        case NodeVariant.FOCUS_SCRIPT_INDIRECT:
            nodeStyle = styles.database_focus_script_indirect;
            break;
        case NodeVariant.FOCUS_SCRIPT_DIRECT:
            nodeStyle = styles.database_focus_script_direct;
            break;
        case NodeVariant.OVERRIDE:
        case NodeVariant.OVERFLOW:
            // Unreachable
            return null;
    }
    // Output column node
    const databaseName = snapshot.readName(database.name());
    const databaseKey = state.currentStack.getDatabaseKey();
    return (
        <motion.div
            key={databaseKey}
            layoutId={databaseKey}
            className={nodeStyle!}
            style={{
                top: position,
                left: state.offsetXColumn,
                width: settings.widthColumn,
                height: settings.heightColumn,
            }}
            data-database={state.currentStack.getDatabaseIdString()}
        >
            {databaseName}
        </motion.div>
    );
}

function renderDatabases(state: CatalogRenderingState, settings: CatalogRenderingSettings, snapshot: CatalogSnapshotReader, scratch: ScratchFlatBuffers, out: React.ReactElement[]) {
    for (let i = 0; i < snapshot.catalogReader.databasesLength(); ++i) {
        // Resolve the database
        const databaseId = i;
        const database = snapshot.catalogReader.databases(databaseId, scratch.database)!;
        const nodeVariant = getVariant(state.databaseVariants, databaseId);
        const isFirstDatabase = state.currentStack.firstDatabase;
        state.currentStack.selectDatabase(i);
        // Add gap of databases
        state.currentWriterY += (isFirstDatabase && i == 0) ? 0 : settings.rowGapDatabase;
        // Remember current y position
        const thisPosY = state.currentWriterY;
        // Render child tables
        renderSchemas(state, settings, snapshot, database, scratch, out);
        // Bump writer if the tables didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.heightDatabase);
        // Emit schema node
        out.push(renderDatabase(state, settings, snapshot, database, thisPosY, nodeVariant)!);
    }
}


export function renderCatalog(state:
    CatalogRenderingState, settings: CatalogRenderingSettings, catalog: CatalogSnapshot): React.ReactElement[] {
    const out: React.ReactElement[] = [];
    const snapshot = catalog.read();
    const scratch: ScratchFlatBuffers = {
        database: new sqlynx.proto.FlatCatalogDatabase(),
        schema: new sqlynx.proto.FlatCatalogSchema(),
        table: new sqlynx.proto.FlatCatalogTable(),
        column: new sqlynx.proto.FlatCatalogColumn(),
    };

    // First, render the overrides
    for (const databaseOverride of state.databaseRenderingOverrides) {
        const database = snapshot.catalogReader.databases(databaseOverride.elementId)!;

        // Are there any schema overrides? - Render them first
        for (const schemaOverride of databaseOverride.childOverrides) {
            const schema = snapshot.catalogReader.schemas(schemaOverride.elementId)!;

            // Are there any table overrides? Render them first
            for (const tableOverride of schemaOverride.childOverrides) {
                const table = snapshot.catalogReader.tables(tableOverride.elementId)!;

                // Are there any column overrides? Render them first.
                for (const columnOverride of schemaOverride.childOverrides) {

                    // XXX Render the override columns
                }

                // XXX Render the override table

                // Render the remaining columns from the override
                renderColumns(state, settings, snapshot, table, scratch, out);

            }

            // XXX Render the override schema

            // Render the remaining tables from the override
            renderTables(state, settings, snapshot, schema, scratch, out);
        }

        // XXX Render the override database

        // Render the remaining schemas
        renderSchemas(state, settings, snapshot, database, scratch, out);
    }

    // Render the remaining databases
    renderDatabases(state, settings, snapshot, scratch, out);
    return out;
}
