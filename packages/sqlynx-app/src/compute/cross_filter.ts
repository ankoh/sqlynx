import { VariantKind } from "utils/variant.js";
import { TableComputationState } from "./computation_state.js";

const HISTOGRAM_CROSS_FILTER = Symbol("HISTOGRAM_CROSS_FILTER");
const MOST_FREQUENT_CROSS_FILTER = Symbol("MOST_FREQUENT_CROSS_FILTER");

export interface CrossFilterConfig {
    columnFilters: Map<number, CrossFilterPredicate>
}

export type CrossFilterPredicate =
    | VariantKind<typeof HISTOGRAM_CROSS_FILTER, HistogramCrossFilterPredicate>
    | VariantKind<typeof MOST_FREQUENT_CROSS_FILTER, MostFrequentCrossFilterPredicate>
    ;

export interface HistogramCrossFilterPredicate {
    selectionBegin: number;
    selectionEnd: number;
}

export interface MostFrequentCrossFilterPredicate {
    frequentValueIndex: number;
}

export async function computeCrossFilters(state: TableComputationState, crossFilter: CrossFilterConfig) {

    for (const [columnId, predicate] of crossFilter.columnFilters) {
        const columnSummary = state.columnGroupSummaries[columnId];
        switch (columnSummary?.type) {
            default:
                break;
        }
    }
}
