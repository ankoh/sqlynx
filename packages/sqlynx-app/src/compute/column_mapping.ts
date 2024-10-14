import { VariantKind } from "../utils/variant.js";
import { ColumnEntryVariant, TableSummaryTask } from "./computation_task.js";

export const ORIGINAL_COLUMN = Symbol('ORIGINAL_COLUMN');
export const DOMAIN_FRACTION_COLUMN = Symbol('DOMAIN_FRACTION_COLUMN');

export type ColumnMapping =
    | VariantKind<typeof ORIGINAL_COLUMN, number>
    | VariantKind<typeof DOMAIN_FRACTION_COLUMN, DomainFractionColumn>
    ;

export interface OriginalColumn {
    /// The column id
    sourceColumnId: number;
}

export interface DomainFractionColumn {
    /// The id of the original column that this domain fraction belongs to
    originalColumnId: number;
    /// The table summary
    tableSummary: TableSummaryTask;
    /// The column statistics
    columnStatistics: ColumnEntryVariant;
}
