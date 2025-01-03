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
    const isUnique = props.columnSummary.analysis.isUnique;

    let barWidth = width;
    const moreButtonWidth = 8;
    if (isUnique) {
        barWidth = Math.max(barWidth) - moreButtonWidth;
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
                            <clipPath id="rounded-bar">
                                <rect x={0} y={0} width={width} height={height} rx={3} ry={3} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${margin.left},${margin.top})`}>
                            <rect x={0} y={0} width={width} height={height} rx={3} ry={3} stroke="hsl(208.5deg 20.69% 40.76%)" strokeWidth={1} fill="transparent" />
                        </g>
                        <g transform={`translate(${margin.left},${margin.top})`} clipPath="url(#rounded-bar)">
                            {[...Array(frequentValueStrings.length)].map((_, i) => (
                                <rect
                                    key={i}
                                    x={Math.min(xScale(Number(xOffsets[i])) + xPadding, xUB)!}
                                    y={0}
                                    width={Math.max(xScale(Number(xCounts[i])) - 2 * xPadding, 0)}
                                    height={height}
                                    fill={i == focusedRow ? "hsl(208.5deg 20.69% 30.76%)" : "hsl(208.5deg 20.69% 50.76%)"}
                                />
                            ))}
                            {isUnique && (
                                <g>
                                    <rect
                                        x={barWidth + xPadding}
                                        height={height}
                                        width={moreButtonWidth - xPadding}
                                        fill={"hsl(208.5deg 20.69% 40.76%)"}
                                    />
                                    {[...Array(3)].map((_, i) => (
                                        <circle
                                            key={i}
                                            cx={barWidth + xPadding + moreButtonWidth / 2}
                                            cy={height / 4 + i * ((height / 2) / 3) + 0.5 * ((height / 2) / 3)}
                                            r={1.2}
                                            fill={"white"}
                                        />
                                    ))}
                                </g>
                            )}
                        </g>
                        <g
                            transform={`translate(${margin.left}, ${margin.top + height})`}
                            onPointerOver={onPointerOver}
                            onPointerMove={onPointerOver}
                            onPointerOut={onPointerOut}
                        >
                            {(focusedRow == null) &&
                                <>
                                    <text x={1} y={0} dy={14} textAnchor="start" fontSize={12} fontWeight={400}>Left</text>
                                    <text x={width - 1} y={0} dy={14} textAnchor="end" fontSize={12} fontWeight={400}>Right</text>
                                    <text x={width / 2} y={0} dy={14} textAnchor="middle" fontSize={12} fontWeight={400}>Middle</text>
                                </>
                            }
                            <rect
                                x={0} y={0}
                                width={width}
                                height={margin.bottom - 1}
                                fillOpacity={0}
                            />
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
                                height={height}
                                fillOpacity={0}
                            />
                        </g>
                    </svg>
                    {(focusedRow != null) && (
                        <span style={{
                            position: "absolute",
                            top: `${margin.top + height + 13 - 12}px`,
                            left: `${margin.left + xScale(Number(xOffsets[focusedRow])) + xScale(Number(xCounts[focusedRow]) / 2)}px`,
                            transform: 'translateX(-50%)',
                            textWrap: "nowrap",
                            fontSize: "12px",
                            fontWeight: 400,
                            pointerEvents: "none",
                            color: "white",
                            backgroundColor: "hsl(208.5deg 20.69% 30.76%)",
                            zIndex: 3,
                            padding: "0px 4px 0px 4px",
                            borderRadius: "3px",
                        }}>{focusedValue ?? NULL_SYMBOL}</span>
                    )}
                </div>
            </div>
        </div>
    );
}
