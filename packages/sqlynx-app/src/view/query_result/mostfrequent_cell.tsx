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

    const margin = { top: 8, right: 8, bottom: 8, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    // Resolve the frequent values
    let frequentValues: FrequentValuesTable | null = null;
    let frequentValuesFormatter: ArrowTableFormatter | null = null;
    switch (props.columnSummary.type) {
        case STRING_COLUMN:
        case LIST_COLUMN:
            frequentValues = props.columnSummary.value.frequentValues;
            frequentValuesFormatter = props.columnSummary.value.frequentValuesFormatter;
            break;
        default:
            break;
    }

    // Compute x-scale and offsets
    const [xScale, xOffsets, xCounts, xSum] = React.useMemo(() => {
        if (frequentValues == null) {
            return [null, null, null];
        }
        assert(frequentValues.schema.fields[1].name == "count");

        const xCounts: BigInt64Array = frequentValues.getChild("count")!.toArray();
        const xOffsets: BigInt64Array = new BigInt64Array(xCounts.length);
        let xSum = BigInt(0);
        for (let i = 0; i < xCounts.length; ++i) {
            xOffsets[i] = xSum;
            xSum += xCounts[i];
        }
        const xScale = d3.scaleLinear()
            .range([0, width])
            .domain([0, Number(xSum)]);

        return [xScale, xOffsets, xCounts, Number(xSum)];
    }, [frequentValues, width]);

    React.useLayoutEffect(() => {
        if (xOffsets == null) {
            return;
        }

        const padding = xScale(0.1);
        const xUB = xScale(xSum);
        const getX = (i: number) => Math.min(xScale(Number(xOffsets[i])) + padding, xUB);
        const getWidth = (i: number) => Math.max(xScale(Number(xCounts[i])) - 2 * padding, 0);

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
            .attr("fill", "black");
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
                    <g transform={`translate(${margin.left},${margin.top})`}>
                        <g ref={barContainer} />
                    </g>

                </svg>
            </div>
        </div>
    );
}
