import * as React from 'react';
import * as styles from './plot_internals_page.module.css';
import * as d3 from 'd3';
import * as arrow from 'apache-arrow';

import { generateRandomData, RandomDataConfig } from '../../utils/random_data.js';

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

function filterTable(input: arrow.Table<testSchemaType>, selectBegin: number, selectEnd: number) {
    const batch = input.batches[0];
    const binVec = batch.getChildAt(0) as arrow.Vector<arrow.Int32>;
    const valueVec = batch.getChildAt(1) as arrow.Vector<arrow.Int32>;

    // Get boundaries
    const beginFloored = Math.floor(selectBegin);
    const beginFrac = (selectBegin + 1) - beginFloored;
    const endFloored = Math.floor(selectEnd);
    const endFrac = selectEnd - endFloored;

    // XXX This would have to be an actual selection against sqlynx-compute, emitting selected rows and a new histogram
    const filteredValues = new Int32Array(batch.numRows);
    for (let i = 0; i < batch.numRows; ++i) {
        let value = valueVec.get(i)!;
        if (i < beginFloored) {
            value = 0;
        } else if (i < selectBegin) {
            value = Math.floor(value * beginFrac);
        } else if (i < endFloored) {
            filteredValues[i] = value;
        } else if (i < selectEnd) {
            filteredValues[i] = value * endFrac;
        } else {
            value = 0;
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

function Example(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const rows = React.useMemo(() => testTable.toArray(), [testTable]);
    const xDomain = [rows[0].binField, rows[rows.length - 1].binField];

    const [rangeSelection, setRangeSelection] = React.useState<[number, number] | null>(null);

    const onRangeSelection = React.useCallback((selBegin: number, selEnd: number) => {
        setRangeSelection([selBegin, selEnd]);
        filterTable(testTable, selBegin, selEnd);
    }, []);
    const onRangeSelectionEnd = React.useCallback(() => {
        setRangeSelection(null);
    }, []);

    React.useLayoutEffect(() => {
        var margin = { top: 0, right: 0, bottom: 0, left: 0 },
            width = 130 - margin.left - margin.right,
            height = 30 - margin.top - margin.bottom;

        var x = d3.scaleBand()
            .range([0, width])
            .domain(rows.map(d => d.binField))
            .padding(0.1);

        var y = d3.scaleLinear()
            .domain([0, 100])
            .range([height, 0]);

        d3.select(containerRef.current).selectChildren().remove();

        const svg = d3
            .select(containerRef.current)
            .append("svg")
            .attr("width", width + margin.left + margin.right)
            .attr("height", height + margin.top + margin.bottom)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        // Add a group fro the bars
        const defaultBars = svg.append('g').attr('class', 'bars');
        // Add a group for the brush clips
        const clippedBars = svg.append('g').attr('class', 'clips');

        // Define the clipping area for the brush
        svg.append('defs')
            .append('clipPath')
            .attr('id', 'brush_clip')
            .append('rect')
            .attr('x', margin.left)
            .attr('y', margin.top)
            .attr('width', width - margin.right)
            .attr('height', height - margin.bottom);

        // Draw the default bars
        defaultBars.selectAll("rect")
            .data(rows)
            .enter()
            .append("rect")
            .attr("x", d => x(d.binField)!)
            .attr("y", d => y(d.countField)!)
            .attr("width", x.bandwidth())
            .attr("height", d => (height - y(d.countField)!))
            .attr("fill", "gray");

        // Draw the clipped bars
        clippedBars.selectAll('rect')
            .data(rows)
            .enter()
            .append('rect')
            .attr("x", d => x(d.binField)!)
            .attr("y", d => y(d.countField)!)
            .attr("width", x.bandwidth())
            .attr("height", d => (height - y(d.countField)!))
            .attr('clip-path', 'url(#brush_clip)');

        const onBrushEnd = (e: d3.D3BrushEvent<unknown>) => {
            if (!e.selection || !e.selection.length) {
                // Span the entire chart area with the clip
                svg.select('#brush_clip>rect')
                    .attr('x', margin.left)
                    .attr('width', width);
                onRangeSelectionEnd();
            }
        }
        const onBrush = (e: d3.D3BrushEvent<unknown>) => {
            // Update the clipping rect using the selection
            const sel = e.selection as [number, number];
            svg.select('#brush_clip>rect')
                .attr('x', sel[0])
                .attr('width', sel[1] - sel[0]);

            var eachBand = x.step();
            onRangeSelection(sel[0] / eachBand, sel[1] / eachBand);
        }
        // Define the brush
        const brush = d3.brushX()
            .extent([
                [x.range()[0], margin.top],
                [x.range()[1], height]
            ])
            .on('start', onBrush)
            .on('brush', onBrush)
            .on('end', onBrushEnd);

        // Add the brush overlay
        svg.append('g')
            .call(brush)
            .selectAll('rect')
            .attr("transform", `translate(${margin.left}, ${margin.top})`)
            .attr('height', height)

        // Add the x-axis
        svg.append("g")
            .attr("transform", `translate(${margin.left}, ${margin.top + height})`)
            .call(d3.axisBottom(x).ticks(2).tickSize(0))

    }, []);

    return (
        <div className={styles.histogram_container}>
            <div className={styles.histogram_plot} ref={containerRef} />
            <div className={styles.histogram_axis_x}>
                <div className={styles.histogram_axis_x_lb}>
                    {xDomain[0]}
                </div>
                <div className={styles.histogram_axis_x_ub}>
                    {xDomain[1]}
                </div>
            </div>
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
                        <Example />
                    </div>
                </div>
            </div>
        </div>
    );
}
