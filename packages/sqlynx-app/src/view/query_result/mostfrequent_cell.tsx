import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './mostfrequent_cell.module.css';

import { StringColumnSummary, TableSummary } from '../../compute/table_transforms.js';
import { dataTypeToString } from './arrow_formatter.js';
import { observeSize } from '../../view/foundations/size_observer.js';
import { assert } from '../../utils/assert.js';
import { NULL_SYMBOL } from './histogram_cell.js';

interface MostFrequentCellProps {
    className?: string;
    style?: React.CSSProperties;
    tableSummary: TableSummary;
    columnSummary: StringColumnSummary;
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

export function MostFrequentCell(props: MostFrequentCellProps): React.ReactElement {
    const svgContainer = React.useRef<HTMLDivElement>(null);
    const svgContainerSize = observeSize(svgContainer);

    const margin = { top: 4, right: 8, bottom: 20, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    // Resolve the frequent values
    const frequentValues = props.columnSummary.frequentValues;
    const frequentValueStrings = props.columnSummary.analysis.frequentValueStrings;
    const frequentValueCounts = props.columnSummary.analysis.frequentValueCounts;
    const frequentValuePercentages = props.columnSummary.analysis.frequentValuePercentages;
    const isUnique = props.columnSummary.analysis.isUnique;
    const hasMore = props.columnSummary.analysis.countDistinct > props.columnSummary.frequentValues.numRows;

    let barWidth = width;
    const moreButtonWidth = 8;
    if (hasMore) {
        barWidth = Math.max(barWidth) - moreButtonWidth;
    }

    // Find row of null value
    let nullRow: number | null = null;
    for (let i = 0; i < frequentValueStrings.length; ++i) {
        if (frequentValueStrings[i] == null) {
            nullRow = i;
        }
    }

    // Compute x-scale and offsets
    const [xScale, xOffsets, xCounts, xSum] = React.useMemo(() => {
        assert(frequentValues.schema.fields[1].name == "count");

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

    const xUB = xScale(xSum);
    const xPadding = 0.5;

    // Track the focused bin id
    const [focusedRow, setFocusedRow] = React.useState<number | null>(null);
    const focusedValue = focusedRow != null ? props.columnSummary.analysis.frequentValueStrings[focusedRow] : null;

    // Listen for pointer events events
    const onPointerOver = React.useCallback((elem: React.MouseEvent<SVGGElement>) => {
        const boundingBox = elem.currentTarget.getBoundingClientRect();
        const relativeX = elem.clientX - boundingBox.left;
        const invertedX = xScale.invert(relativeX);
        const row = Math.min(resolveRowUsingOffset(xOffsets, invertedX), frequentValueStrings.length - 1);
        setFocusedRow(row);
    }, [xScale]);
    const onPointerOut = React.useCallback((_elem: React.MouseEvent<SVGGElement>) => {
        setFocusedRow(null);
    }, []);

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
        >
            <div className={styles.root}>
                <div className={styles.header_container}>
                    {dataTypeToString(props.columnSummary.columnEntry.inputFieldType)}
                </div>
                <div className={styles.plot_container} ref={svgContainer}>
                    <svg
                        className={styles.plot_svg}
                        width={width + margin.left + margin.right}
                        height={height + margin.top + margin.bottom}
                    >
                        <defs>
                            <pattern id="diagonal-stripes" patternUnits="userSpaceOnUse" width="4" height="4">
                                <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" style={{
                                    stroke: "hsl(208.5deg 20.69% 50.76%)",
                                    strokeOpacity: 0.8,
                                    strokeWidth: 1
                                }}
                                />
                            </pattern>
                            <clipPath id="rounded-bar">
                                <rect x={0} y={0} width={width} height={height} rx={3} ry={3} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${margin.left},${margin.top})`} clipPath="url(#rounded-bar)">
                            {[...Array(frequentValueStrings.length)].map((_, i) => (
                                <rect
                                    key={i}
                                    x={Math.min(xScale(Number(xOffsets[i])) + xPadding, xUB)}
                                    y={0}
                                    width={Math.max(xScale(Number(xCounts[i])) - 2 * xPadding, 0)}
                                    height={height}
                                    fill={
                                        i == nullRow
                                            ? (
                                                i == focusedRow
                                                    ? "hsl(208.5deg 20.69% 30.76%)"
                                                    : "hsl(210deg 17.5% 74.31%)"
                                            ) : (
                                                i == focusedRow
                                                    ? "hsl(208.5deg 20.69% 30.76%)"
                                                    : "hsl(208.5deg 20.69% 50.76%)"
                                            )}
                                />
                            ))}
                            {(nullRow != null) && <rect
                                x={Math.min(xScale(Number(xOffsets[nullRow])) + xPadding, xUB)}
                                y={0}
                                width={Math.max(xScale(Number(xCounts[nullRow])) - 2 * xPadding, 0)}
                                height={height}
                                fill="url(#diagonal-stripes)"
                            />}
                            {hasMore && (
                                <g>
                                    <rect
                                        x={barWidth + xPadding}
                                        height={height}
                                        width={moreButtonWidth - xPadding}
                                        fill={"hsl(208.5deg 20.69% 40.76%)"}
                                    />
                                </g>
                            )}
                        </g>
                        <g transform={`translate(${margin.left},${margin.top})`}>
                            <rect x={0} y={0} width={width} height={height} rx={3} ry={3} stroke="hsl(208.5deg 20.69% 40.76%)" strokeWidth={1} fill="transparent" />
                        </g>
                        <g
                            transform={`translate(${margin.left},${margin.top})`}
                            onPointerOver={onPointerOver}
                            onPointerMove={onPointerOver}
                            onPointerOut={onPointerOut}
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
