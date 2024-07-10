import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';

import { CatalogSnapshot } from '../../connectors/catalog_snapshot.js';

export interface GraphBoundaries {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    totalWidth: number;
    totalHeight: number;
}

export interface CatalogViewConfig {
    databaseNodeWidth: number;
    databaseNodeHeight: number;
    schemaNodeWidth: number;
    schemaNodeHeight: number;
    tableNodeWidth: number;
    tableNodeHeightPerRow: number;
    tableNodeHeightMore: number;
    paddingVertical: number;
    paddingHorizontal: number;

    cappedColumnCount: number;
}

export interface CatalogFocusInfo {
    scrollOffsetY: number;
}

export interface CatalogViewModel { }

export function computeCatalogViewModel(catalog: CatalogSnapshot, focus:
    CatalogFocusInfo, config: CatalogViewConfig): CatalogViewModel {
    const snapshot = catalog.snapshot.read(new sqlynx.proto.FlatCatalog());

    const tmpDatabase = new sqlynx.proto.FlatCatalogDatabase();
    const tmpSchema = new sqlynx.proto.FlatCatalogSchema();
    const tmpTable = new sqlynx.proto.FlatCatalogTable();
    const tmpColumn = new sqlynx.proto.FlatCatalogColumn();

    for (let d = 0; d < snapshot.databasesLength(); ++d) {
        let database = snapshot.databases(d)!;
        let schemaCount = database.schemaCount();
        let schemasBegin = database.schemasBegin();

        for (let s = 0; s < schemaCount; ++s) {
            let schema = snapshot.schemas(schemasBegin + s)!;
            let tableCount = schema.tableCount();
            let tablesBegin = schema.tablesBegin();

            for (let t = 0; t < tableCount; ++t) {
                let table = snapshot.tables(tablesBegin + t)!;
                let columnCount = table.columnCount();
                let columnsBegin = table.columnsBegin();

                for (let c = 0; c < Math.min(columnCount, config.cappedColumnCount); ++c) {
                    let column = snapshot.columns(columnsBegin + c)!;
                    let columnName = column.name;
                }
            }
        }
    }

    return {};
}
