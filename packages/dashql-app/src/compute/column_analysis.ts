import * as arrow from 'apache-arrow';

import { ArrowTableFormatter } from './arrow_formatter.js';
import { TableAggregation, OrdinalColumnAnalysis, StringColumnAnalysis, StringGridColumnGroup, OrdinalGridColumnGroup, BinnedValuesTable, FrequentValuesTable } from './computation_types.js';
import { assert } from '../utils/assert.js';
import { isTemporalType } from './arrow_columns.js';

export function analyzeOrdinalColumn(tableSummary: TableAggregation, columnEntry: OrdinalGridColumnGroup, binnedValues: BinnedValuesTable, binnedValuesFormatter: ArrowTableFormatter, filteredTotalCount: number | null = null): OrdinalColumnAnalysis {
    const totalCountVector = tableSummary.table.getChild(tableSummary.countStarFieldName!) as arrow.Vector<arrow.Int64>;

    const unfilteredTotalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const totalCount = filteredTotalCount ?? unfilteredTotalCount;
    const minFieldId = tableSummary.tableFieldsByName.get(columnEntry.statsFields!.minAggregateFieldName!)!;
    const maxFieldId = tableSummary.tableFieldsByName.get(columnEntry.statsFields!.maxAggregateFieldName!)!;
    const minValue = tableSummary.tableFormatter.getValue(0, minFieldId) ?? "";
    const maxValue = tableSummary.tableFormatter.getValue(0, maxFieldId) ?? "";

    assert(binnedValues.schema.fields[0].name == "bin");
    assert(binnedValues.schema.fields[1].name == "count");
    assert(binnedValues.schema.fields[3].name == "binLowerBound");
    const binIdVector = binnedValues.getChildAt(0) as arrow.Vector<arrow.Uint32>;
    const binCountVector = binnedValues.getChildAt(1) as arrow.Vector<arrow.Int64>;

    const nullBinRowIdx = binnedValues.numRows - 1;
    const nullBinId = Number(binIdVector.get(nullBinRowIdx) ?? -1);
    assert(binnedValues.numRows === (columnEntry.binCount + 1));
    assert(nullBinId === columnEntry.binCount);

    const countNull = Number(binCountVector.get(nullBinRowIdx) ?? BigInt(0));
    const countNotNull = filteredTotalCount == null
        ? totalCount - countNull
        : unfilteredTotalCount - countNull;

    const regularBinCount = columnEntry.binCount;
    const binLowerBounds: string[] = [];
    const binPercentages = new Float64Array(regularBinCount);
    const regularBinValueCounts = new BigInt64Array(regularBinCount);

    const isTemporal = isTemporalType(columnEntry.inputFieldType.typeId);
    const temporalFmt = isTemporal ? Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium' }) : null;
    const lbCol = isTemporal ? binnedValues.getChildAt(3)! : null;

    for (let i = 0; i < regularBinCount; ++i) {
        const binCount = binCountVector.get(i) ?? BigInt(0);
        let binLB: string;
        if (isTemporal && lbCol) {
            const epochMs = lbCol.get(i);
            binLB = epochMs == null ? "" : temporalFmt!.format(new Date(epochMs));
        } else {
            binLB = binnedValuesFormatter.getValue(i, 3) ?? "";
        }
        const binPercentage = (totalCount == 0) ? 0 : (Number(binCount) / totalCount);
        binLowerBounds.push(binLB);
        binPercentages[i] = binPercentage;
        regularBinValueCounts[i] = binCount;
    }

    return {
        totalCount,
        countNotNull: countNotNull,
        countNull: countNull,
        minValue: minValue,
        maxValue: maxValue,
        binCount: regularBinCount,
        binValueCounts: regularBinValueCounts,
        binPercentages: binPercentages,
        binLowerBounds: binLowerBounds,
    };
}

export function analyzeStringColumn(tableSummary: TableAggregation, columnEntry: StringGridColumnGroup, frequentValueTable: FrequentValuesTable, frequentValuesFormatter: ArrowTableFormatter, filteredTotalCount: number | null = null): StringColumnAnalysis {
    const totalCountVector = tableSummary.table.getChild(tableSummary.countStarFieldName!) as arrow.Vector<arrow.Int64>;
    const notNullCountVector = tableSummary.table.getChild(columnEntry.statsFields!.countFieldName) as arrow.Vector<arrow.Int64>;
    const distinctCountVector = tableSummary.table.getChild(columnEntry.statsFields!.distinctCountFieldName!) as arrow.Vector<arrow.Int64>;

    const unfilteredTotalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const totalCount = filteredTotalCount ?? unfilteredTotalCount;
    const notNullCount = Number(notNullCountVector.get(0) ?? BigInt(0));
    const distinctCount = Number(distinctCountVector.get(0) ?? BigInt(0));

    assert(frequentValueTable.schema.fields[0].name == "key");
    assert(frequentValueTable.getChild("count") != null);

    const frequentValueCounts = frequentValueTable.getChild("count")!.toArray();
    const frequentValuePercentages = new Float64Array(frequentValueTable.numRows);
    const frequentValueStrings = [];
    for (let i = 0; i < frequentValueTable.numRows; ++i) {
        frequentValuePercentages[i] = totalCount == 0 ? 0 : (Number(frequentValueCounts[i]) / totalCount);
        frequentValueStrings.push(frequentValuesFormatter.getValue(i, 0));
    }

    const keyIdColumn = (frequentValueTable as arrow.Table).getChild("keyId");
    if (keyIdColumn == null) {
        throw new Error("Missing keyId column in frequent values table");
    }
    const frequentValueIds = keyIdColumn.toArray() as BigInt64Array;

    return {
        totalCount,
        countNotNull: notNullCount,
        countNull: unfilteredTotalCount - notNullCount,
        countDistinct: distinctCount,
        isUnique: notNullCount == distinctCount,
        frequentValueStrings: frequentValueStrings,
        frequentValueIds: frequentValueIds,
        frequentValueCounts: frequentValueCounts,
        frequentValuePercentages: frequentValuePercentages,
    };
}
