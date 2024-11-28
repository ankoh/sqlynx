import * as React from 'react';
import * as styles from './mostfrequent_cell.module.css';

import { ColumnSummaryVariant } from '../../compute/table_transforms.js';
import { observeSize } from '../../view/foundations/size_observer.js';

interface MostFrequentCellProps {
    columnSummary: ColumnSummaryVariant;
}

export function MostFrequentCell(props: MostFrequentCellProps): React.ReactElement {
    const rootContainer = React.useRef<HTMLDivElement>(null);
    const rootSize = observeSize(rootContainer);
    const stackedBarContainer = React.useRef<SVGGElement>(null);

    const margin = { top: 8, right: 8, bottom: 16, left: 8 },
        width = (rootSize?.width ?? 130) - margin.left - margin.right,
        height = (rootSize?.height ?? 50) - margin.top - margin.bottom;

    //    const [xScale, yScale] = React.useMemo(() => {
    //        const xValues: string[] = [];
    //        for (let i = 0; i < BIN_COUNT; ++i) {
    //            xValues.push(i.toString());
    //        }
    //        let yMin = BigInt(0);
    //        let yMax = BigInt(0);
    //        for (let i = 0; i < binCounts.length; ++i) {
    //            yMax = binCounts[i] > yMax ? binCounts[i] : yMax;
    //        }
    //        let yDomain = [Number(yMin), Number(yMax)];
    //
    //        const histXScale = d3.scaleBand()
    //            .range([0, histWidth])
    //            .domain(xValues)
    //            .padding(0.1);
    //        const histYScale = d3.scaleLinear()
    //            .range([height, 0])
    //            .domain(yDomain);
    //        // The x-scale of the null plot consists of a single band + padding
    //        const nullsXScale = d3.scaleBand()
    //            .range([0, histXScale.bandwidth() + 2 * histXScale.paddingOuter()])
    //            .domain([NULL_SYMBOL])
    //            .padding(0.1);
    //        const nullsYScale = d3.scaleLinear()
    //            .range([height, 0])
    //            .domain(yDomain);
    //
    //        return [histXScale, histYScale, nullsXScale, nullsYScale];
    //    }, [histWidth, height]);

    return (
        <div className={styles.root} ref={rootContainer}>
            Foo
            <svg
                className={styles.plot_svg}
                width={width + margin.left + margin.right}
                height={height + margin.top + margin.bottom}
            >
                <g transform={`translate(${margin.left},${margin.top})`}>
                </g>

            </svg>
        </div>
    );
}
