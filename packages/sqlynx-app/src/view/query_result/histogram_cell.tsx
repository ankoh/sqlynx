import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './histogram_cell.module.css';

import { observeSize } from '../../view/foundations/size_observer.js';
import { ColumnSummaryVariant, LIST_COLUMN, ORDINAL_COLUMN, SKIPPED_COLUMN, STRING_COLUMN } from '../../compute/table_transforms.js';

const NULL_SYMBOL = "∅";

interface HistogramCellProps {
    columnSummary: ColumnSummaryVariant;
}

export function HistogramCell(props: HistogramCellProps): React.ReactElement {
    let bins: Int32Array;
    let binCounts: BigInt64Array;
    switch (props.columnSummary.type) {
        case ORDINAL_COLUMN: {
            const table = props.columnSummary.value.binnedValues;
            bins = table.getChild("bin")!.toArray();
            binCounts = table.getChild("count")!.toArray();
            break;
        }
        case STRING_COLUMN:
        case LIST_COLUMN:
        case SKIPPED_COLUMN:
            return <div />;
    }

    const rootContainer = React.useRef<HTMLDivElement>(null);
    const rootSize = observeSize(rootContainer);
    const histBarContainer = React.useRef<SVGGElement>(null);
    const nullBarContainer = React.useRef<SVGGElement>(null);
    const selectionBarContainer = React.useRef<SVGGElement>(null);
    const brushContainer = React.useRef<SVGGElement>(null);
    const histAxisContainer = React.useRef<SVGGElement>(null);
    const nullAxisContainer = React.useRef<SVGGElement>(null);

    const margin = { top: 8, right: 8, bottom: 16, left: 8 },
        width = (rootSize?.width ?? 130) - margin.left - margin.right,
        height = (rootSize?.height ?? 50) - margin.top - margin.bottom;

    const nullsWidth = 12;
    const nullsPadding = 2;
    const histWidth = width - nullsWidth - nullsPadding;

    const [histXScale, histYScale, nullsXScale, nullsYScale] = React.useMemo(() => {
        const xValues = [...bins].map(i => i.toString());
        let yMin = BigInt(0);
        let yMax = BigInt(0);
        for (let i = 0; i < binCounts.length; ++i) {
            yMax = binCounts[i] > yMax ? binCounts[i] : yMax;
        }
        let yDomain = [Number(yMin), Number(yMax)];

        const histXScale = d3.scaleBand()
            .range([0, histWidth])
            .domain(xValues)
            .padding(0.1);
        const histYScale = d3.scaleLinear()
            .range([height, 0])
            .domain(yDomain);
        // The x-scale of the null plot consists of a single band + padding
        const nullsXScale = d3.scaleBand()
            .range([0, histXScale.bandwidth() + 2 * histXScale.paddingOuter()])
            .domain([NULL_SYMBOL])
            .padding(0.1);
        const nullsYScale = d3.scaleLinear()
            .range([height, 0])
            .domain(yDomain);

        return [histXScale, histYScale, nullsXScale, nullsYScale];
    }, [histWidth, height]);

    React.useLayoutEffect(() => {
        // Draw the histogram bars
        d3.select(histBarContainer.current)
            .selectChildren()
            .remove();
        d3.select(histBarContainer.current)
            .selectAll("rect")
            .data(bins.keys())
            .enter()
            .append("rect")
            .attr("x", i => histXScale(bins[i].toString())!)
            .attr("y", i => histYScale(Number(binCounts[i])))
            .attr("width", histXScale.bandwidth())
            .attr("height", i => (height - histYScale(Number(binCounts[i]))!))
            .attr("fill", "gray");

        // Draw null bar
        d3.select(nullBarContainer.current)
            .selectChildren()
            .remove();
        d3.select(nullBarContainer.current)
            .selectAll("rect")
            .data([{
                x: nullsXScale(NULL_SYMBOL)!,
                y: nullsYScale(10)!
            }])
            .enter()
            .append("rect")
            .attr("x", d => d.x)
            .attr("y", d => d.y)
            .attr("width", nullsXScale.bandwidth())
            .attr("height", d => (height - d.y))
            .attr("fill", "orange");

        const onBrushEnd = (_e: d3.D3BrushEvent<unknown>) => { };
        const onBrush = (_e: d3.D3BrushEvent<unknown>) => { };
        // Define the brush
        const brush = d3.brushX()
            .extent([
                [histXScale.range()[0], 0],
                [histXScale.range()[1], height]
            ])
            .on('start', onBrush)
            .on('brush', onBrush)
            .on('end', onBrushEnd);

        // Add the brush overlay
        d3.select(brushContainer.current!)
            .call(brush)
            .selectAll('rect')
            .attr("y", 0)
            .attr('height', height);

        // Add the histogram x-axis
        d3.select(histAxisContainer.current!)
            .call(d3.axisBottom(histXScale).ticks(2).tickSize(0));

        // Add the nulls x-axis
        d3.select(nullAxisContainer.current!)
            .call(d3.axisBottom(nullsXScale).tickValues([NULL_SYMBOL]).tickSize(0));

    }, [histXScale, histYScale]);

    return (
        <div className={styles.histogram_container} ref={rootContainer}>
            <svg
                className={styles.histogram_plot_svg}
                width={width + margin.left + margin.right}
                height={height + margin.top + margin.bottom}
            >
                <g transform={`translate(${margin.left},${margin.top})`}>
                    <g ref={histBarContainer} />
                    <g ref={selectionBarContainer} />
                    <g ref={brushContainer} />
                    <g ref={histAxisContainer} transform={`translate(0, ${height})`} />
                    <g ref={nullBarContainer} transform={`translate(${histWidth + nullsPadding}, 0)`} />
                    <g ref={nullAxisContainer} transform={`translate(${histWidth + nullsPadding}, ${height})`} />
                </g>

            </svg>
        </div>
    );
}
