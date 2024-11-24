import * as React from 'react';
import * as styles from './plot_internals_page.module.css';
import * as d3 from 'd3';
import * as arrow from 'apache-arrow';

import { generateRandomData, RandomDataConfig } from '../../utils/random_data.js';
import { observeSize } from '../../view/foundations/size_observer.js';

const config: RandomDataConfig = {
    fields: [
        {
            name: "binField",
            type: new arrow.Int32(),
            nullable: false,
            generateScalarValue: i => i + 10
        },
        {
            name: "countField",
            type: new arrow.Int32(),
            nullable: false,
            generateScalarValue: _ => Math.floor(20 + Math.random() * 80),
        },
    ],
    resultBatches: 1,
    resultRowsPerBatch: 16
};
const [testSchema, testBatches] = generateRandomData(config);
type testSchemaType = { binField: arrow.Int32, countField: arrow.Int32 };
const testTable = new arrow.Table<testSchemaType>(testSchema, testBatches);

function filterTable(input: arrow.Table<testSchemaType>, selectBegin: number, selectEnd: number): arrow.Table {
    const batch = input.batches[0];
    const valueVec = batch.getChildAt(1) as arrow.Vector<arrow.Int32>;

    // Get boundaries
    const beginFloored = Math.floor(selectBegin);
    const beginFrac = (beginFloored + 1) - selectBegin;
    const endFloored = Math.floor(selectEnd);
    const endFrac = selectEnd - endFloored;

    // XXX This would have to be an actual selection against sqlynx-compute, emitting selected rows and a new histogram
    const filteredValues = new Int32Array(batch.numRows);
    for (let i = 0; i < batch.numRows; ++i) {
        let value = valueVec.get(i)!;
        if (i < beginFloored) {
            filteredValues[i] = 0;
        } else if (i == beginFloored) {
            filteredValues[i] = Math.floor(value * beginFrac);
        } else if (i < endFloored) {
            filteredValues[i] = value;
        } else if (i < selectEnd) {
            filteredValues[i] = value * endFrac;
        } else {
            filteredValues[i] = 0;
        }
    }

    let copiedChildren: arrow.Data[] = [];
    for (let i = 0; i < batch.numCols; ++i) {
        const childVec = batch.getChildAt(i)!;
        copiedChildren.push(childVec.data[0]);
    }

    const filteredData = arrow.makeData<arrow.Int32>({
        type: new arrow.Int32(),
        nullCount: 0,
        data: filteredValues
    });
    copiedChildren[1] = filteredData;

    const structData = arrow.makeData({
        nullCount: 0,
        type: new arrow.Struct(batch.schema.fields),
        children: copiedChildren
    });
    const filteredBatch = new arrow.RecordBatch(input.schema, structData);
    const filteredTable = new arrow.Table(input.schema, filteredBatch);
    return filteredTable;
}

const NULL_SYMBOL = "∅";

export function ExampleHistogram(): React.ReactElement {
    const rows = React.useMemo(() => testTable.toArray(), [testTable]);

    const histBarContainer = React.useRef<SVGGElement>(null);
    const nullBarContainer = React.useRef<SVGGElement>(null);
    const selectionBarContainer = React.useRef<SVGGElement>(null);
    const brushContainer = React.useRef<SVGGElement>(null);
    const histAxisContainer = React.useRef<SVGGElement>(null);
    const nullAxisContainer = React.useRef<SVGGElement>(null);

    const rootContainer = React.useRef<HTMLDivElement>(null);
    const rootSize = observeSize(rootContainer);

    const margin = { top: 8, right: 8, bottom: 16, left: 8 },
        width = (rootSize?.width ?? 130) - margin.left - margin.right,
        height = (rootSize?.height ?? 50) - margin.top - margin.bottom;

    const nullsWidth = 12;
    const nullsPadding = 2;
    const histWidth = width - nullsWidth - nullsPadding;

    const [histXScale, histYScale, nullsXScale, nullsYScale] = React.useMemo(() => {
        const histXScale = d3.scaleBand()
            .range([0, histWidth])
            .domain(rows.map(d => d.binField))
            .padding(0.1);
        const histYScale = d3.scaleLinear()
            .range([height, 0])
            .domain([0, 100]);
        // The x-scale of the null plot consists of a single band + padding
        const nullsXScale = d3.scaleBand()
            .range([0, histXScale.bandwidth() + 2 * histXScale.paddingOuter()])
            .domain([NULL_SYMBOL])
            .padding(0.1);
        const nullsYScale = d3.scaleLinear()
            .range([height, 0])
            .domain([0, 100]);

        return [histXScale, histYScale, nullsXScale, nullsYScale];
    }, [histWidth, height]);

    const [rangeSelection, setRangeSelection] = React.useState<[number, number] | null>(null);
    const onRangeSelection = React.useCallback((selBegin: number, selEnd: number) => {
        const table = filterTable(testTable, selBegin, selEnd);
        const rows = table.toArray();

        d3.select(selectionBarContainer.current)
            .selectChildren()
            .remove();
        d3.select(selectionBarContainer.current)
            .selectAll('rect')
            .data(rows)
            .enter()
            .append('rect')
            .attr("x", d => histXScale(d.binField)!)
            .attr("y", d => histYScale(d.countField)!)
            .attr("width", histXScale.bandwidth())
            .attr("height", d => (height - histYScale(d.countField)!));
    }, [histXScale, histYScale]);
    const onRangeSelectionEnd = React.useCallback(() => {
        setRangeSelection(null);
    }, []);

    React.useLayoutEffect(() => {
        // Draw the histogram bars
        d3.select(histBarContainer.current)
            .selectChildren()
            .remove();
        d3.select(histBarContainer.current)
            .selectAll("rect")
            .data(rows)
            .enter()
            .append("rect")
            .attr("x", d => histXScale(d.binField)!)
            .attr("y", d => histYScale(d.countField)!)
            .attr("width", histXScale.bandwidth())
            .attr("height", d => (height - histYScale(d.countField)!))
            .attr("fill", "gray");

        // Draw null bar
        d3.select(nullBarContainer.current)
            .selectChildren()
            .remove();
        d3.select(nullBarContainer.current)
            .selectAll("rect")
            .data([{
                x: nullsXScale(NULL_SYMBOL)!,
                y: nullsYScale(50)!
            }])
            .enter()
            .append("rect")
            .attr("x", d => d.x)
            .attr("y", d => d.y)
            .attr("width", nullsXScale.bandwidth())
            .attr("height", d => (height - d.y))
            .attr("fill", "orange");

        const onBrushEnd = (e: d3.D3BrushEvent<unknown>) => {
            if (!e.selection || !e.selection.length) {
                onRangeSelectionEnd();
            }
        }
        const onBrush = (e: d3.D3BrushEvent<unknown>) => {
            const sel = e.selection as [number, number];
            var eachBand = histXScale.step();
            onRangeSelection(sel[0] / eachBand, sel[1] / eachBand);
        }
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
            // .attr("transform", `translate(${margin.left}, ${margin.top})`)
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

export function PlotInternalsPage(): React.ReactElement {
    return (
        <div className={styles.root}>
            <div className={styles.component_section}>
                <div className={styles.component_section_header}>
                    D3 Plots
                </div>
                <div className={styles.component}>
                    <div className={styles.component_title}>
                        Histogram
                    </div>
                    <div className={styles.component_variants}>
                        <ExampleHistogram />
                    </div>
                </div>
            </div>
        </div>
    );
}
