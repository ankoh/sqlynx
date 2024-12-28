import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './mostfrequent_cell.module.css';

import { ColumnSummaryVariant, FrequentValuesTable, LIST_COLUMN, STRING_COLUMN, TableSummary } from '../../compute/table_transforms.js';
import { ArrowTableFormatter, dataTypeToString } from './arrow_formatter.js';
import { observeSize } from '../../view/foundations/size_observer.js';
import { assert } from '../../utils/assert.js';

interface MostFrequentCellProps {
    tableSummary: TableSummary;
    columnSummary: ColumnSummaryVariant;
}

export function MostFrequentCell(props: MostFrequentCellProps): React.ReactElement {
    const rootContainer = React.useRef<HTMLDivElement>(null);
    const svgContainer = React.useRef<HTMLDivElement>(null);
    const svgContainerSize = observeSize(svgContainer);
    const barContainer = React.useRef<SVGGElement>(null);
    const barMoreContainer = React.useRef<SVGGElement>(null);

    const margin = { top: 4, right: 8, bottom: 20, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    // Resolve the frequent values
    let frequentValues: FrequentValuesTable | null = null;
    let frequentValueIsNull: Uint8Array | null = null;
    let frequentValueCounts: BigInt64Array | null = null;
    let frequentValuePercentages: Float64Array | null = null;
    let frequentValuesFormatter: ArrowTableFormatter | null = null;
    let isUnique = false;
    let distinctCount = 0;
    let nullCount = 0;
    switch (props.columnSummary.type) {
        case STRING_COLUMN:
        case LIST_COLUMN: {
            frequentValues = props.columnSummary.value.frequentValues;
            frequentValueIsNull = props.columnSummary.value.analysis.frequentValueIsNull;
            frequentValueCounts = props.columnSummary.value.analysis.frequentValueCounts;
            frequentValuePercentages = props.columnSummary.value.analysis.frequentValuePercentages;
            frequentValuesFormatter = props.columnSummary.value.frequentValuesFormatter;
            isUnique = props.columnSummary.value.analysis.isUnique;
            distinctCount = props.columnSummary.value.analysis.countDistinct;
            nullCount = props.columnSummary.value.analysis.countNull;
            break;
        }
        default:
            break;
    }

    let barWidth = width;
    const moreButtonWidth = 8;
    if (isUnique) {
        barWidth = Math.max(barWidth) - moreButtonWidth;
    }

    // Compute x-scale and offsets
    const [xScale, xOffsets, xCounts, xSum] = React.useMemo(() => {
        if (frequentValues == null || frequentValueCounts == null) {
            return [null, null, null];
        }
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

    React.useLayoutEffect(() => {
        if (xOffsets == null) {
            return;
        }

        const padding = 0.5;
        const xUB = xScale(xSum);
        const getX = (i: number) => Math.min(xScale(Number(xOffsets[i])) + padding, xUB);
        const getWidth = (i: number) => Math.max(xScale(Number(xCounts[i])) - 2 * padding, 0);

        const barFill = frequentValueIsNull
            ? ((i: number) => frequentValueIsNull[i] ? "hsl(210deg 17.5% 74.31%)" : "hsl(208.5deg 20.69% 55.76%)")
            : ((_i: number) => "hsl(208.5deg 20.69% 55.76%)");

        // Draw the bars
        d3.select(barContainer.current)
            .selectChildren()
            .remove();
        d3.select(barContainer.current)
            .selectAll("rect")
            .data(xOffsets.keys())
            .enter()
            .append("rect")
            .attr("x", i => getX(i))
            .attr("width", i => getWidth(i))
            .attr("height", _ => height)
            .attr("fill", barFill)
            .on("mouseover", function(this: SVGRectElement, _event: any, _i: number) {
                d3.select(this)
                    .attr("fill", "hsl(208.5deg 20.69% 20.76%)");
            })
            .on("mouseout", function(this: SVGRectElement, _event: any, _i: number) {
                d3.select(this)
                    .attr("fill", "hsl(208.5deg 20.69% 50.76%)");
            });

        if (isUnique) {
            // Draw "more" button
            d3.select(barMoreContainer.current)
                .selectChildren()
                .remove();
            d3.select(barMoreContainer.current)
                .append("rect")
                .attr("x", barWidth + padding)
                .attr("width", moreButtonWidth - padding)
                .attr("height", height)
                .attr("fill", "hsl(208.5deg 20.69% 40.76%)");
            const dotOffset = height / 4;
            const dotSpacing = (height / 2) / 3;
            let nextDotPos = dotOffset;
            for (let i = 0; i < 3; ++i) {
                d3.select(barMoreContainer.current)
                    .append("circle")
                    .attr("cx", barWidth + padding + moreButtonWidth / 2)
                    .attr("cy", nextDotPos + dotSpacing / 2)
                    .attr("r", 1.2)
                    .attr("fill", "white");
                nextDotPos += dotSpacing;
            }
        }

    }, [xOffsets]);

    if (props.columnSummary.value == null) {
        return <div />;
    }

    return (
        <div className={styles.root} ref={rootContainer}>
            <div className={styles.header_container}>
                {dataTypeToString(props.columnSummary.value.columnEntry.inputFieldType)}
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
                        <g ref={barContainer} />
                        <g ref={barMoreContainer} />
                    </g>
                </svg>
            </div>
        </div>
    );
}
