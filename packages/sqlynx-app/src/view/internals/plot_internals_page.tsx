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
            generateScalarValue: i => i
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

    React.useEffect(() => {
        const rows = testTable.toArray();

        var margin = { top: 0, right: 0, bottom: 0, left: 0 },
            width = 130 - margin.left - margin.right,
            height = 30 - margin.top - margin.bottom;

        const svg = d3.select(containerRef.current)
            .append("svg")
            .attr("width", width + margin.left + margin.right)
            .attr("height", height + margin.top + margin.bottom)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        var x = d3.scaleBand()
            .range([0, width])
            .domain(rows.map(d => d.intField))
            .padding(0.1);

        svg.append("g")
            .attr("transform", `translate(0, ${height})`)
            .call(d3.axisBottom(x).tickValues([]).tickSize(0))
        //    .selectAll("text")
        //    .attr("transform", "translate(-10,0)rotate(-45)")
        //    .style("text-anchor", "end");

        var y = d3.scaleLinear()
            .domain([0, 100])
            .range([height, 0]);
        // svg.append("g")
        //     .call(d3.axisLeft(y));

        svg.selectAll("mybar")
            .data(rows)
            .enter()
            .append("rect")
            .attr("x", d => x(d.intField)!)
            .attr("y", d => y(d.doubleField)!)
            .attr("width", x.bandwidth())
            .attr("height", d => (height - y(d.doubleField)!))
            .attr("fill", "#69b3a2");

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
