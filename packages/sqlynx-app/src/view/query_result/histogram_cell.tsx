import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './histogram_cell.module.css';

import { observeSize } from '../../view/foundations/size_observer.js';
import { BIN_COUNT, OrdinalColumnSummary, TableSummary } from '../../compute/table_transforms.js';
import { dataTypeToString } from './arrow_formatter.js';

export const NULL_SYMBOL = "∅";

interface HistogramCellProps {
    className?: string;
    style?: React.CSSProperties;
    tableSummary: TableSummary;
    columnSummary: OrdinalColumnSummary;
}

export function HistogramCell(props: HistogramCellProps): React.ReactElement {
    const table = props.columnSummary.binnedValues;
    const bins = table.getChild("bin")!.toArray();
    const binCounts = table.getChild("count")!.toArray();
    const inputNullable = props.columnSummary.columnEntry.inputFieldNullable;

    const svgContainer = React.useRef<HTMLDivElement>(null);
    const svgContainerSize = observeSize(svgContainer);
    const brushContainer = React.useRef<SVGGElement>(null);

    const margin = { top: 8, right: 8, bottom: 20, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    let histWidth = width;
    const nullsWidth = 12;
    const nullsMargin = 2;
    if (inputNullable) {
        histWidth -= nullsWidth + nullsMargin;
    }

    // Compute d3 scales
    const [histXScale, histYScale, nullsXScale, nullsYScale, nullsXWidth] = React.useMemo(() => {
        const xValues: string[] = [];
        for (let i = 0; i < BIN_COUNT; ++i) {
            xValues.push(i.toString());
        }
        let yMin = BigInt(0);
        let yMax = BigInt(props.columnSummary.analysis.countNull ?? 0);
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
        const nullsXWidth = histXScale.bandwidth() + 2 * histXScale.paddingOuter();
        const nullsXScale = d3.scaleBand()
            .range([0, nullsXWidth])
            .domain([NULL_SYMBOL])
            .padding(0.1);
        const nullsYScale = d3.scaleLinear()
            .range([height, 0])
            .domain(yDomain);

        return [histXScale, histYScale, nullsXScale, nullsYScale, nullsXWidth];
    }, [histWidth, height, svgContainerSize]);

    // Setup d3 brush
    React.useLayoutEffect(() => {
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
            .selectChildren()
            .remove();
        d3.select(brushContainer.current!)
            .call(brush)
            .selectAll('rect')
            .attr("y", 0)
            .attr('height', height);
    }, [histXScale, histYScale]);

    // Adjust null padding to center null bar horizontally
    const nullsPadding = (nullsWidth - nullsXScale.bandwidth()) / 2;

    // Track the focused bin id
    const [focusedBin, setFocusedBin] = React.useState<number | null>(null);
    const [focusedNull, setFocusedNull] = React.useState<boolean | null>(null);
    let focusDescription: string | null = null;
    if (focusedBin != null) {
        const binValueCounts = props.columnSummary.analysis.binValueCounts;
        const binPercentages = props.columnSummary.analysis.binPercentages;
        const percentage = Math.round(binPercentages[focusedBin] * 100 * 100) / 100;
        const rows = binValueCounts[focusedBin];
        focusDescription = `${rows} ${rows == 1n ? "row" : "rows"} (${percentage}%)`
    } else if (focusedNull) {
        const nullPercentage = props.columnSummary.analysis.countNull / (props.columnSummary.analysis.countNull + props.columnSummary.analysis.countNotNull);
        const percentage = Math.round(nullPercentage * 100 * 100) / 100;
        const rows = props.columnSummary.analysis.countNull;
        focusDescription = `${rows} ${rows == 1 ? "row" : "rows"} (${percentage}%)`
    }

    // Listen for pointer events events
    const onPointerOverBin = React.useCallback((elem: React.MouseEvent<SVGGElement>) => {
        const paddingInner = histXScale.paddingInner() * histXScale.bandwidth();
        const paddingOuter = histXScale.paddingOuter() * histXScale.bandwidth();
        const boundingBox = elem.currentTarget.getBoundingClientRect();
        const relativeX = elem.clientX - boundingBox.left;
        const innerX = Math.max(relativeX, paddingOuter) - paddingOuter;
        const binWidth = histXScale.bandwidth() + paddingInner;
        const bin = Math.min(Math.floor(innerX / binWidth), binCounts.length - 1);

        setFocusedBin(bin);
    }, [histXScale]);
    const onPointerOutBin = React.useCallback((_elem: React.MouseEvent<SVGGElement>) => {
        setFocusedBin(null);
    }, []);
    const onPointerOverNull = React.useCallback((_elem: React.MouseEvent<SVGGElement>) => {
        setFocusedNull(true);
    }, []);
    const onPointerOutNull = React.useCallback((_elem: React.MouseEvent<SVGGElement>) => {
        setFocusedNull(false);
    }, []);

    // Resolve bin labels
    const binLabels = props.columnSummary.analysis.binLowerBounds;
    const binLabelLeft = binLabels[0];
    const binLabelRight = binLabels[binLabels.length - 1];
    const binLabelFocused = focusedBin != null ? binLabels[focusedBin] : null;

    return (
        <div
            className={props.className}
            style={{
                ...props.style,
                zIndex: focusedBin != null ? 100 : props.style?.zIndex
            }}
        >
            <div className={styles.root}>
                <div className={styles.header_container}>
                    {focusDescription ?? dataTypeToString(props.columnSummary.columnEntry.inputFieldType)}
                </div>
                <div className={styles.plot_container} ref={svgContainer}>
                    <svg
                        className={styles.plot_svg}
                        width={width + margin.left + margin.right}
                        height={height + margin.top + margin.bottom}
                    >
                        <g transform={`translate(${margin.left},${margin.top})`}>
                            <g>
                                {[...Array(bins.length)].map((_, i) => (
                                    <rect
                                        key={i}
                                        x={histXScale(bins[i].toString())!}
                                        y={histYScale(Number(binCounts[i]))}
                                        width={histXScale.bandwidth()}
                                        height={height - histYScale(Number(binCounts[i]))}
                                        fill={i == focusedBin ? "hsl(208.5deg 20.69% 30.76%)" : "hsl(208.5deg 20.69% 50.76%)"}
                                    />
                                ))}
                            </g>
                            <g ref={brushContainer}
                                onPointerOver={onPointerOverBin}
                                onPointerMove={onPointerOverBin}
                                onPointerOut={onPointerOutBin}
                            />
                            <g
                                transform={`translate(0, ${height})`}
                                onPointerOver={onPointerOverBin}
                                onPointerMove={onPointerOverBin}
                                onPointerOut={onPointerOutBin}
                            >
                                <line x1={0} y1={1} x2={histWidth} y2={1} stroke={"hsl(208.5deg 20.69% 40.76%)"} />
                                <rect
                                    x={0} y={0}
                                    width={histWidth}
                                    height={margin.bottom - 1}
                                    fillOpacity={0}
                                />
                            </g>
                            {inputNullable &&
                                <g
                                    transform={`translate(${histWidth + nullsMargin + nullsPadding}, 0)`}
                                    onPointerOver={onPointerOverNull}
                                    onPointerMove={onPointerOverNull}
                                    onPointerOut={onPointerOutNull}
                                >
                                    <rect
                                        x={nullsXScale(NULL_SYMBOL)}
                                        y={nullsYScale(props.columnSummary.analysis.countNull ?? 0)}
                                        width={nullsXScale.bandwidth()}
                                        height={height - nullsYScale(props.columnSummary.analysis.countNull ?? 0)}
                                        fill={focusedNull ? "hsl(208.5deg 20.69% 30.76%)" : "hsl(210deg 17.5% 74.31%)"}
                                    />
                                    <g transform={`translate(0, ${height})`}>
                                        <line
                                            x1={0} y1={1}
                                            x2={nullsXWidth} y2={1}
                                            stroke={"hsl(208.5deg 20.69% 40.76%)"}
                                        />
                                        <rect
                                            x={nullsXScale(NULL_SYMBOL)}
                                            y={0}
                                            width={nullsXScale.bandwidth()}
                                            height={margin.bottom}
                                            fillOpacity={0}
                                        />
                                    </g>
                                </g>
                            }
                        </g>

                    </svg>
                    {(binLabelFocused == null)
                        ? (
                            <div
                                className={styles.axis_labels_container}
                                style={{
                                    position: "absolute",
                                    top: `${margin.top + height + 2}px`,
                                    left: `${margin.left}px`,
                                    width: `${histWidth}px`,
                                }}
                            >
                                <span className={styles.axis_label_left}>{binLabelLeft}</span>
                                <span className={styles.axis_label_right} >{binLabelRight}</span>
                            </div>
                        ) : (
                            <span style={{
                                position: "absolute",
                                top: `${margin.top + height + 13 - 12}px`,
                                left: `${margin.left + (histXScale(focusedBin!.toString()) ?? 0) + histXScale.bandwidth() / 2}px`,
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
                            }}>{binLabelFocused}</span>
                        )}
                    {inputNullable && (
                        !focusedNull
                            ? (
                                <span
                                    style={{
                                        position: "absolute",
                                        top: `${margin.top + height + 2}px`,
                                        left: `${margin.left + histWidth + nullsMargin + nullsPadding + nullsXScale.bandwidth() / 2}px`,
                                        transform: 'translateX(-50%)',
                                        fontSize: "12px",
                                        fontWeight: 400,
                                        pointerEvents: "none",
                                    }}
                                >{NULL_SYMBOL}</span>

                            ) : (
                                <span className={styles.axis_label_overlay} style={{
                                    top: `${margin.top + height + 13 - 12}px`,
                                    left: `${margin.left + histWidth + nullsMargin + nullsPadding + nullsXScale.bandwidth() / 2}px`,
                                }}>{NULL_SYMBOL}</span>
                            )
                    )}
                </div>
            </div>
        </div>
    );
}
