import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';

import { CatalogSnapshot } from '../../connectors/catalog_snapshot.js';

/// The boundaries of the rendered catalog view tracked when rendering
export interface CatalogViewBoundaries {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    totalWidth: number;
    totalHeight: number;
}

/// The catalog view config
export interface CatalogViewConfig {
    databaseNodeWidth: number;
    databaseNodeHeight: number;
    schemaNodeWidth: number;
    schemaNodeHeight: number;
    tableNodeWidth: number;
    tableNodeHeightPerRow: number;
    tableNodeHeightMore: number;
    tableMaxColumnCount: number;
    paddingVertical: number;
    paddingHorizontal: number;
}

/// The node rendering mode
enum NodeRendering {
    DEFAULT = 0,
    SKIP = 1,
    FOCUS_VIEW_DIRECT = 2,
    FOCUS_VIEW_INDIRECT = 3,
    FOCUS_SCRIPT_DIRECT = 4,
    FOCUS_SCRIPT_INDIRECT = 5,
    FOCUS_COMPLETION_LIST_DIRECT = 6,
    FOCUS_COMPLETION_LIST_INDIRECT = 7,
    FOCUS_COMPLETION_SELECTED_DIRECT = 8,
    FOCUS_COMPLETION_SELECTED_INDIRECT = 9,
}

/// Helper to get the rendering mode.
/// We reserve 4 bits per entry to specify the rendering mode.
function getRenderingMode(modes: Uint8Array, index: number) {
    const shift = (index & 0b1) * 4;
    return (modes[index >> 1] >> shift) as NodeRendering;
}
/// Helper to set the rendering mode.
function setRenderingMode(modes: Uint8Array, index: number, node: NodeRendering) {
    const shift = (index & 0b1) * 4;
    const mask = 0b1111 << shift;
    const value = node << shift;
    const entry = modes[index >> 1];
    modes[index >> 1] = (entry & mask) | value;
}

/// A catalog rendering state
interface CatalogRenderingState {
    /// The current scroll offset
    scrollOffset: number;
    /// The amount of currently visible vertical pixels
    scrollWindowHeight: number;

    /// The first database that should be rendered
    firstRenderedDatabase: number;
    /// The first schema that should be rendered
    firstRenderedSchema: number;
    /// The first table that should be rendered
    firstRenderedTable: number;
    /// The first column that should be rendered
    firstRenderedColumn: number;

    /// When renderDefault is set, we bypass checking the rendering modes.
    /// We use this if we have no selections and just want to render everything.
    renderDefault: boolean;

    /// Rendering modes for the databases
    databaseRendering: Uint8Array;
    /// Rendering modes for schemas
    schemaRendering: Uint8Array;
    /// Rendering modes for tables
    tableRendering: Uint8Array;
    /// Rendering modes for columns
    columnRendering: Uint8Array;
}

export interface CatalogViewModel { }

export function computeCatalogViewModel(catalog: CatalogSnapshot, _rendering:
    CatalogRenderingState, config: CatalogViewConfig): CatalogViewModel {
    const snapshot = catalog.read();

    const tmpDatabase = new sqlynx.proto.FlatCatalogDatabase();
    const tmpSchema = new sqlynx.proto.FlatCatalogSchema();
    const tmpTable = new sqlynx.proto.FlatCatalogTable();
    const tmpColumn = new sqlynx.proto.FlatCatalogColumn();

    for (let d = 0; d < snapshot.catalogReader.databasesLength(); ++d) {
        const database = snapshot.catalogReader.databases(d, tmpDatabase)!;
        const databaseName = snapshot.readName(database.name());
        const schemaCount = database.schemaCount();
        const schemasBegin = database.schemasBegin();

        for (let s = 0; s < schemaCount; ++s) {
            const schema = snapshot.catalogReader.schemas(schemasBegin + s, tmpSchema)!;
            const schemaName = snapshot.readName(schema.name());
            const tableCount = schema.tableCount();
            const tablesBegin = schema.tablesBegin();

            for (let t = 0; t < tableCount; ++t) {
                const table = snapshot.catalogReader.tables(tablesBegin + t, tmpTable)!;
                const tableName = snapshot.readName(table.name());
                const columnCount = table.columnCount();
                const columnsBegin = table.columnsBegin();

                for (let c = 0; c < Math.min(columnCount, config.tableMaxColumnCount); ++c) {
                    const column = snapshot.catalogReader.columns(columnsBegin + c, tmpColumn)!;
                    const columnName = snapshot.readName(column.name());
                }
            }
        }
    }

    return {};
}
