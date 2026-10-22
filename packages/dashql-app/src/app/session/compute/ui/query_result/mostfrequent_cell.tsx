import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './mostfrequent_cell.module.css';

import { ColumnAggregationVariant, StringColumnAggregation, STRING_COLUMN, TableAggregation, WithFilterEpoch } from '../../../../../compute/computation_types.js';
import { dataTypeToString } from '../../../../../compute/arrow_formatter.js';
import { observeSize } from '../../../../../ui/foundations/size_observer.js';
import { assert } from '../../../../../utils/assert.js';
import { NULL_SYMBOL } from './histogram_cell.js';
import { COLUMN_SUMMARY_COLORS, getTotalBarColor, getFilteredBarColor } from './data_table_colors.js';
import { formatHistogramFocusDescription } from './histogram_label.js';
import { arePropsEqualWithStyle } from './memo_props.js';

export type MostFrequentValueFilterCallback = (table: TableAggregation, columnIndex: number, column: StringColumnAggregation, frequentValueId: number | null) => void;

export const MAX_FOCUSED_VALUE_LENGTH = 100;

export function truncateFocusedValue(value: string): string {
    if (value.length <= MAX_FOCUSED_VALUE_LENGTH) return value;
    return `${value.slice(0, MAX_FOCUSED_VALUE_LENGTH - 3)}...`;
}

interface MostFrequentCellProps {
    className?: string;
    style?: React.CSSProperties;
    tableAggregation: TableAggregation;
    columnIndex: number;
    columnAggregate: StringColumnAggregation;
    filteredColumnAggregation: WithFilterEpoch<ColumnAggregationVariant> | null;
    onFilter: MostFrequentValueFilterCallback;
}

function resolveRowUsingOffset(offsets: BigInt64Array, offset: number) {
    /// XXX Binary search
    for (let i = 0; i < offsets.length; ++i) {
        if (offsets[i] > offset) {
            return Math.max(i - 1, 0);
        }
    }
    return Math.max(offsets.length - 1, 0);
}

function MostFrequentCellImpl(props: MostFrequentCellProps): React.ReactElement {
    const svgContainer = React.useRef<HTMLDivElement>(null);
    const svgContainerSize = observeSize(svgContainer);
    const pendingFilterFrame = React.useRef<number | null>(null);
    const pendingFilterValueId = React.useRef<number | null>(null);
    const diagonalStripesId = React.useId();
    const roundedBarClipId = React.useId();

    const margin = { top: 4, right: 8, bottom: 20, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    // Resolve the frequent values
    const frequentValues = props.columnAggregate.frequentValuesTable;
    const frequentValueStrings = props.columnAggregate.analysis.frequentValueStrings;
    const frequentValueCounts = props.columnAggregate.analysis.frequentValueCounts;
    const frequentValuePercentages = props.columnAggregate.analysis.frequentValuePercentages;
    const isUnique = props.columnAggregate.analysis.isUnique;
    const hasMore = props.columnAggregate.analysis.countDistinct > props.columnAggregate.frequentValuesTable.numRows;

    const moreButtonWidth = 8;
    const barWidth = Math.max(width - (hasMore ? moreButtonWidth : 0), 0);

    // Find row of null value
    let nullRow: number | null = null;
    for (let i = 0; i < frequentValueStrings.length; ++i) {
        if (frequentValueStrings[i] == null) {
            nullRow = i;
        }
    }

    // Compute x-scale and offsets
    const [xScale, xOffsets, xCounts, xSum] = React.useMemo(() => {
        assert(frequentValues.schema.fields[1].name == "count" || frequentValues.schema.fields[2].name == "count");

        const xCounts: BigInt64Array = frequentValueCounts;
        const xOffsets: BigInt64Array = new BigInt64Array(xCounts.length);
        let xSum = BigInt(0);
        for (let i = 0; i < xCounts.length; ++i) {
            xOffsets[i] = xSum;
            xSum += xCounts[i];
        }
        const xScale = d3.scaleLinear()
            .range([0, barWidth])
            .domain([0, Number(xSum)]);

        return [xScale, xOffsets, xCounts, Number(xSum)];
    }, [frequentValues, barWidth]);

    // Build a lookup map from value ID to filtered count
    const filteredCountByValueId = React.useMemo(() => {
        if (props.filteredColumnAggregation?.type !== STRING_COLUMN) {
            return null;
        }
        const filteredAgg = props.filteredColumnAggregation.value;
        const map = new Map<bigint, bigint>();
        const filteredIds = filteredAgg.analysis.frequentValueIds;
        const filteredCounts = filteredAgg.analysis.frequentValueCounts;
        for (let i = 0; i < filteredIds.length; ++i) {
            map.set(filteredIds[i], filteredCounts[i]);
        }
        return map;
    }, [props.filteredColumnAggregation]);

    const filteredRowCount = props.filteredColumnAggregation?.type === STRING_COLUMN
        ? props.filteredColumnAggregation.value.analysis.totalCount
        : null;

    // Get the value IDs for the unfiltered aggregate
    const frequentValueIds = props.columnAggregate.analysis.frequentValueIds;

    const xUB = xScale(xSum);
    const xPadding = 0.5;

    // Track the focused bin id
    const [focusedRow, setFocusedRow] = React.useState<number | null>(null);
    let focusedValue: string | null = null;
    let focusDescription: string | null = null;
    if (focusedRow != null) {
        const value = frequentValueStrings[focusedRow];
        focusedValue = value == null ? null : truncateFocusedValue(value);
        const valueId = frequentValueIds[focusedRow];
        const filteredCount = filteredCountByValueId == null
            ? null
            : filteredCountByValueId.get(valueId) ?? 0n;
        focusDescription = formatHistogramFocusDescription(
            frequentValueCounts[focusedRow],
            props.columnAggregate.analysis.totalCount,
            filteredCount,
            filteredRowCount,
        );
    }

    const onFilterRef = React.useRef(props.onFilter);
    const tableAggregationRef = React.useRef(props.tableAggregation);
    const columnIndexRef = React.useRef(props.columnIndex);
    const columnAggregateRef = React.useRef(props.columnAggregate);
    onFilterRef.current = props.onFilter;
    tableAggregationRef.current = props.tableAggregation;
    columnIndexRef.current = props.columnIndex;
    columnAggregateRef.current = props.columnAggregate;

    const queueFilter = React.useCallback((valueId: number | null) => {
        pendingFilterValueId.current = valueId;
        if (pendingFilterFrame.current != null) {
            return;
        }
        pendingFilterFrame.current = requestAnimationFrame(() => {
            pendingFilterFrame.current = null;
            onFilterRef.current(
                tableAggregationRef.current,
                columnIndexRef.current,
                columnAggregateRef.current,
                pendingFilterValueId.current,
            );
        });
    }, []);

    React.useEffect(() => () => {
        if (pendingFilterFrame.current != null) {
            cancelAnimationFrame(pendingFilterFrame.current);
        }
    }, []);

    // Listen for pointer events events
    const onPointerOver = React.useCallback((elem: React.MouseEvent<SVGGElement>) => {
        const boundingBox = elem.currentTarget.getBoundingClientRect();
        const relativeX = elem.clientX - boundingBox.left;
        if (relativeX < 0 || relativeX >= barWidth || frequentValueStrings.length == 0) {
            setFocusedRow(null);
            return;
        }
        const invertedX = xScale.invert(relativeX);
        const row = Math.min(resolveRowUsingOffset(xOffsets, invertedX), frequentValueStrings.length - 1);
        setFocusedRow(row);
    }, [barWidth, frequentValueStrings.length, xOffsets, xScale]);
    const onPointerOut = React.useCallback((_elem: React.MouseEvent<SVGGElement>) => {
        setFocusedRow(null);
    }, []);
    const onClick = React.useCallback((elem: React.MouseEvent<SVGGElement>) => {
        const boundingBox = elem.currentTarget.getBoundingClientRect();
        const relativeX = elem.clientX - boundingBox.left;
        if (relativeX < 0 || relativeX >= barWidth || frequentValueStrings.length == 0) {
            return;
        }
        const invertedX = xScale.invert(relativeX);
        const row = Math.min(resolveRowUsingOffset(xOffsets, invertedX), frequentValueStrings.length - 1);
        elem.stopPropagation();
        queueFilter(Number(frequentValueIds[row]));
    }, [barWidth, frequentValueIds, frequentValueStrings.length, queueFilter, xOffsets, xScale]);

    const percentageLeft = frequentValuePercentages[0];
    const percentageRight = frequentValuePercentages[frequentValuePercentages.length - 1];
    const labelLeft = `${Math.round(percentageLeft * 100 * 100) / 100}%`;
    const labelRight = `${Math.round(percentageRight * 100 * 100) / 100}%`;

    return (
        <div
            className={props.className}
            style={{
                ...props.style,
                zIndex: focusedRow != null ? 100 : props.style?.zIndex
            }}
            onClick={() => queueFilter(null)}
        >
            <div className={styles.root}>
                <div className={styles.header_container}>
                    {focusDescription ?? dataTypeToString(props.columnAggregate.columnEntry.inputFieldType)}
                </div>
                <div className={styles.plot_container} ref={svgContainer}>
                    <svg
                        className={styles.plot_svg}
                        width={width + margin.left + margin.right}
                        height={height + margin.top + margin.bottom}
                    >
                        <defs>
                            <pattern id={diagonalStripesId} patternUnits="userSpaceOnUse" width="4" height="4">
                                <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" style={{
                                    stroke: "hsl(208.5deg 20.69% 50.76%)",
                                    strokeOpacity: 0.8,
                                    strokeWidth: 1
                                }}
                                />
                            </pattern>
                            <clipPath id={roundedBarClipId}>
                                <rect x={0} y={0} width={width} height={height} rx={3} ry={3} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${margin.left},${margin.top})`} clipPath={`url(#${roundedBarClipId})`}>
                            <rect
                                x={0}
                                y={0}
                                width={width}
                                height={height}
                                fill={COLUMN_SUMMARY_COLORS.totalBarWithFilter}
                            />
                            {[...Array(frequentValueStrings.length)].map((_, i) => {
                                const barX = Math.min(xScale(Number(xOffsets[i])) + xPadding, xUB);
                                const barWidth = Math.max(xScale(Number(xCounts[i])) - 2 * xPadding, 0);
                                // Skip if invalid
                                if (isNaN(barX) || isNaN(barWidth)) return null;

                                const totalCount = xCounts[i];
                                const isNull = i == nullRow;
                                const isFocused = i == focusedRow;
                                const hasFilter = filteredCountByValueId != null;

                                // Compute filtered fill height
                                let fillHeight = 0;
                                if (hasFilter && totalCount > 0n) {
                                    const valueId = frequentValueIds[i];
                                    const filteredCount = filteredCountByValueId.get(valueId) ?? 0n;
                                    fillHeight = height * Number(filteredCount) / Number(totalCount);
                                }

                                return (
                                    <g key={i}>
                                        {/* Background bar (total count) */}
                                        <rect
                                            x={barX}
                                            y={0}
                                            width={barWidth}
                                            height={height}
                                            fill={getTotalBarColor(hasFilter, isFocused, isNull)}
                                        />
                                        {/* Filtered fill (from bottom) */}
                                        {hasFilter && fillHeight > 0 && (
                                            <rect
                                                x={barX}
                                                y={height - fillHeight}
                                                width={barWidth}
                                                height={fillHeight}
                                                fill={getFilteredBarColor(isFocused, isNull)}
                                            />
                                        )}
                                    </g>
                                );
                            })}
                            {(nullRow != null) && <rect
                                x={Math.min(xScale(Number(xOffsets[nullRow])) + xPadding, xUB)}
                                y={0}
                                width={Math.max(xScale(Number(xCounts[nullRow])) - 2 * xPadding, 0)}
                                height={height}
                                fill={`url(#${diagonalStripesId})`}
                            />}
                            {hasMore && (
                                <g>
                                    <rect
                                        x={barWidth + xPadding}
                                        height={height}
                                        width={moreButtonWidth - xPadding}
                                        fill={getTotalBarColor(filteredCountByValueId != null, false)}
                                    />
                                </g>
                            )}
                        </g>
                        <g transform={`translate(${margin.left},${margin.top})`}>
                            <rect
                                x={0} y={0}
                                width={width}
                                height={height}
                                rx={3} ry={3}
                                stroke="hsl(210deg 17.5% 84.31%)"
                                strokeWidth={1}
                                fill="transparent"
                            />
                        </g>
                        <g
                            transform={`translate(${margin.left},${margin.top})`}
                            onPointerOver={onPointerOver}
                            onPointerMove={onPointerOver}
                            onPointerOut={onPointerOut}
                            onClick={onClick}
                        >
                            <rect
                                x={0} y={0}
                                width={width}
                                height={height + margin.bottom - 1}
                                fillOpacity={0}
                            />
                        </g>
                    </svg>
                    {isUnique && (
                        <span className={styles.plot_label_overlay} style={{
                            top: `${margin.top + height / 2}px`,
                            left: `${margin.left + width / 2}px`,
                        }}>
                            all distinct
                        </span>
                    )}
                    {(focusedRow == null)
                        ? (
                            <div
                                className={styles.axis_labels_container}
                                style={{
                                    position: "absolute",
                                    top: `${margin.top + height + 2}px`,
                                    left: `${margin.left}px`,
                                    width: `${width}px`,
                                }}
                            >
                                <span className={styles.axis_label_left}>{labelLeft}</span>
                                <span className={styles.axis_label_right} >{labelRight}</span>
                            </div>
                        ) : (
                            <span className={styles.axis_label_overlay} style={{
                                top: `${margin.top + height + 13 - 12}px`,
                                left: `${margin.left + xScale(Number(xOffsets[focusedRow])) + xScale(Number(xCounts[focusedRow]) / 2)}px`,
                            }}>{focusedValue ?? NULL_SYMBOL}</span>
                        )}
                </div>
            </div>
        </div>
    );
}

export const MostFrequentCell = React.memo(MostFrequentCellImpl, arePropsEqualWithStyle);
