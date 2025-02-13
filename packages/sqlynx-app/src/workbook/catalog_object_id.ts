import * as sqlynx from '@ankoh/sqlynx-core';

import { VariantKind } from '../utils/variant.js';

export interface QualifiedDatabaseId {
    /// The database id
    database: number;
}
export interface QualifiedSchemaId extends QualifiedDatabaseId {
    /// The schema id
    schema: number;
}
export interface QualifiedTableId extends QualifiedSchemaId {
    /// The table
    table: sqlynx.ContextObjectID.Value;
}
export interface QualifiedTableColumnId extends QualifiedTableId {
    /// The column index
    column: number;
}

export const QUALIFIED_DATABASE_ID = Symbol('FOCUS_DATABASE');
export const QUALIFIED_SCHEMA_ID = Symbol('FOCUS_SCHEMA');
export const QUALIFIED_TABLE_ID = Symbol('FOCUS_TABLE');
export const QUALIFIED_TABLE_COLUMN_ID = Symbol('QUALIFIED_TABLE_COLUMN');

export type QualifiedCatalogObjectID =
    VariantKind<typeof QUALIFIED_DATABASE_ID, QualifiedDatabaseId>
    | VariantKind<typeof QUALIFIED_SCHEMA_ID, QualifiedSchemaId>
    | VariantKind<typeof QUALIFIED_TABLE_ID, QualifiedTableId>
    | VariantKind<typeof QUALIFIED_TABLE_COLUMN_ID, QualifiedTableColumnId>
    ;
