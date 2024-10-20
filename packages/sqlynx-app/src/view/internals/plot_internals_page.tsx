import * as React from 'react';
import * as styles from './plot_internals_page.module.css';
import * as d3 from 'd3';
import * as arrow from 'apache-arrow';

import { generateRandomData, RandomDataConfig } from '../../utils/random_data.js';

const config: RandomDataConfig = {
    fields: [
        {
            name: "intField",
            type: new arrow.Int32(),
            nullable: false,
            generateScalarValue: i => i + 10
        },
        {
            name: "doubleField",
            type: new arrow.Float64(),
            nullable: false,
            generateScalarValue: _ => 20 + Math.random() * 80,
        },
    ],
    resultBatches: 1,
    resultRowsPerBatch: 16
};
const [testSchema, testBatches] = generateRandomData(config);
const testTable = new arrow.Table(testSchema, testBatches);

function Example(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const rows = React.useMemo(() => testTable.toArray(), [testTable]);

    const onSelect = React.useCallback((begin: number, end: number) => {
        console.log([begin, end]);
    }, []);
    const onSelectEnd = React.useCallback(() => {
        console.log("selection end");
    }, []);

    React.useEffect(() => {
        var margin = { top: 0, right: 0, bottom: 0, left: 0 },
            width = 130 - margin.left - margin.right,
            height = 30 - margin.top - margin.bottom;

        var x = d3.scaleBand()
            .range([0, width])
            .domain(rows.map(d => d.intField))
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

        // Create group for the x-axis
        svg.append("g")
            .attr("transform", `translate(0, ${height})`)
            .call(d3.axisBottom(x).ticks(2).tickSize(0))

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
            .attr("x", d => x(d.intField)!)
            .attr("y", d => y(d.doubleField)!)
            .attr("width", x.bandwidth())
            .attr("height", d => (height - y(d.doubleField)!))
            .attr("fill", "gray");

        // Draw the clipped bars
        clippedBars.selectAll('rect')
            .data(rows)
            .enter()
            .append('rect')
            .attr("x", d => x(d.intField)!)
            .attr("y", d => y(d.doubleField)!)
            .attr("width", x.bandwidth())
            .attr("height", d => (height - y(d.doubleField)!))
            .attr('clip-path', 'url(#brush_clip)')
            .style('stroke', 'white');

        const onBrushEnd = (e: d3.D3BrushEvent<null>) => {
            if (!e.selection || !e.selection.length) {
                // Span the entire chart area with the clip
                svg.select('#brush_clip>rect')
                    .attr('x', margin.left)
                    .attr('width', width);
                onSelectEnd();
            }
        }
        const onBrush = (e: d3.D3BrushEvent<null>) => {
            // Update the clipping rect using the selection
            const sel = e.selection as [number, number];
            svg.select('#brush_clip>rect')
                .attr('x', sel[0])
                .attr('width', sel[1] - sel[0]);

            var eachBand = x.step();
            onSelect(sel[0] / eachBand, sel[1] / eachBand);
        }
        // Define the brush
        const brush = d3.brushX()
            .extent([
                [x.range()[0], margin.top],
                [x.range()[1], height - margin.bottom]
            ])
            .on('start', onBrush)
            .on('brush', onBrush)
            .on('end', onBrushEnd);

        // Add the brush overlay
        svg.append('g')
            .call(brush)
            .selectAll('rect')
            .attr('y', 0)
            .attr('height', height)

    }, []);

    return (
        <div ref={containerRef} />
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
