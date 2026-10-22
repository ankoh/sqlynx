import * as React from 'react';
import * as d3 from 'd3';
import * as styles from './histogram_cell.module.css';

import { observeSize } from '../../../../../ui/foundations/size_observer.js';
import { ColumnAggregationVariant, OrdinalColumnAggregation, ORDINAL_COLUMN, TableAggregation, WithFilterEpoch } from '../../../../../compute/computation_types.js';
import { dataTypeToString } from '../../../../../compute/arrow_formatter.js';
import { getTotalBarColor, getFilteredBarColor } from './data_table_colors.js';
import { HistogramBars, HistogramNullBar, NULL_SYMBOL } from './histogram_bars.js';
import { useHistogramBrush } from './histogram_brush.js';
import { formatHistogramFocusDescription } from './histogram_label.js';
import { arePropsEqualWithStyle } from './memo_props.js';

export { NULL_SYMBOL } from './histogram_bars.js';
export { SettledBrushUpdates } from './histogram_brush.js';

export type HistogramFilterCallback = (table: TableAggregation, columnId: number, column: OrdinalColumnAggregation, filter: [number, number] | null) => void;
export type BrushingStateCallback = (isBrushing: boolean) => void;

interface HistogramCellProps {
    className?: string;
    style?: React.CSSProperties;
    tableAggregation: TableAggregation;
    columnIndex: number;
    columnAggregate: OrdinalColumnAggregation;
    filteredColumnAggregation: WithFilterEpoch<ColumnAggregationVariant> | null;
    selection: [number, number] | null;
    onFilter: HistogramFilterCallback;
    onBrushingChange?: BrushingStateCallback;
}

function HistogramCellImpl(props: HistogramCellProps): React.ReactElement {
    const inputNullable = props.columnAggregate.columnEntry.inputFieldNullable;
    const countNull = props.columnAggregate.columnAnalysis.countNull;
    const binCounts = props.columnAggregate.columnAnalysis.binValueCounts;
    const binCount = props.columnAggregate.columnAnalysis.binCount;

    const svgContainer = React.useRef<HTMLDivElement>(null);
    const svgContainerSize = observeSize(svgContainer);
    const margin = { top: 8, right: 8, bottom: 20, left: 8 },
        width = (svgContainerSize?.width ?? 130) - margin.left - margin.right,
        height = (svgContainerSize?.height ?? 50) - margin.top - margin.bottom;

    let histWidth = width;
    const nullsWidth = 12;
    const nullsMargin = 2;
    if (inputNullable) {
        histWidth -= nullsWidth + nullsMargin;
    }

    // Compute d3 scales - fixed dependencies to include data that affects the scales
    const [histXScale, histYScale, nullsXScale, nullsYScale, nullsXWidth] = React.useMemo(() => {
        const xValues: string[] = [];
        for (let i = 0; i < binCount; ++i) {
            xValues.push(i.toString());
        }
        let yMin = BigInt(0);
        let yMax = BigInt(countNull ?? 0);
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
    }, [histWidth, height, binCount, binCounts, countNull]);

    // Listen for brush events
    const onBrushUpdate = React.useCallback((e: d3.D3BrushEvent<unknown>) => {
        if (!props.onFilter) {
            return;
        }
        if (e.selection == null) {
            props.onFilter(props.tableAggregation, props.columnIndex, props.columnAggregate, null);
            return;
        }
        const pixelSelection = e.selection as [number, number];
        if (pixelSelection[0] == pixelSelection[1]) {
            props.onFilter(props.tableAggregation, props.columnIndex, props.columnAggregate, null);
            return;
        }
        const step = histXScale.step();
        const fractionalBinStart = pixelSelection[0] / step;
        const fractionalBinEnd = pixelSelection[1] / step;
        const binSelection: [number, number] = [fractionalBinStart, fractionalBinEnd];
        props.onFilter(props.tableAggregation, props.columnIndex, props.columnAggregate, binSelection);
    }, [props.tableAggregation, props.columnAggregate, props.onFilter, props.columnIndex, histXScale]);

    const clearFilter = React.useCallback(() => {
        props.onFilter(props.tableAggregation, props.columnIndex, props.columnAggregate, null);
    }, [props.tableAggregation, props.columnIndex, props.columnAggregate, props.onFilter]);

    const brushSelection = React.useMemo<[number, number] | null>(() => {
        if (props.selection == null) {
            return null;
        }
        const step = histXScale.step();
        return [props.selection[0] * step, props.selection[1] * step];
    }, [histXScale, props.selection]);

    const { brushContainer, clearBrush } = useHistogramBrush({
        xScale: histXScale,
        height,
        selection: brushSelection,
        onBrushUpdate,
        onClear: clearFilter,
        onBrushingChange: props.onBrushingChange,
    });

    // Adjust null padding to center null bar horizontally
    const nullsPadding = (nullsWidth - nullsXScale.bandwidth()) / 2;

    // Extract filtered bin counts and null count if available
    const hasFilteredAggregate = props.filteredColumnAggregation != null && props.filteredColumnAggregation.type === ORDINAL_COLUMN;
    const [filteredBinCounts, filteredNullCount, filteredRowCount] = React.useMemo(() => {
        if (props.filteredColumnAggregation?.type !== ORDINAL_COLUMN) return [null, null, null];
        const filteredAgg = props.filteredColumnAggregation.value;
        return [
            filteredAgg.columnAnalysis.binValueCounts,
            filteredAgg.columnAnalysis.countNull,
            filteredAgg.columnAnalysis.totalCount,
        ];
    }, [props.filteredColumnAggregation]);

    // Colors for total vs filtered bars (using shared color scheme)
    const totalBarColor = getTotalBarColor(hasFilteredAggregate, false);
    const totalBarFocusedColor = getTotalBarColor(hasFilteredAggregate, true);
    const filteredBarColor = getFilteredBarColor(false);
    const filteredBarFocusedColor = getFilteredBarColor(true);
    // Null bar colors
    const totalNullBarColor = getTotalBarColor(hasFilteredAggregate, false, true);
    const totalNullBarFocusedColor = getTotalBarColor(hasFilteredAggregate, true, true);

    // Track the focused bin id
    const [focusedBin, setFocusedBin] = React.useState<number | null>(null);
    const [focusedNull, setFocusedNull] = React.useState<boolean | null>(null);
    let focusDescription: string | null = null;
    if (focusedBin != null) {
        focusDescription = formatHistogramFocusDescription(
            binCounts[focusedBin],
            props.columnAggregate.columnAnalysis.totalCount,
            filteredBinCounts?.[focusedBin] ?? null,
            filteredRowCount,
        );
    } else if (focusedNull) {
        focusDescription = formatHistogramFocusDescription(
            BigInt(countNull),
            props.columnAggregate.columnAnalysis.totalCount,
            filteredNullCount == null ? null : BigInt(filteredNullCount),
            filteredRowCount,
        );
    }

    // Listen for pointer events
    const onPointerOverBin = React.useCallback((elem: React.MouseEvent<SVGGElement>) => {
        const paddingInner = histXScale.paddingInner() * histXScale.bandwidth();
        const paddingOuter = histXScale.paddingOuter() * histXScale.bandwidth();
        const boundingBox = elem.currentTarget.getBoundingClientRect();
        const relativeX = elem.clientX - boundingBox.left;
        const innerX = Math.max(relativeX, paddingOuter) - paddingOuter;
        const binWidth = histXScale.bandwidth() + paddingInner;
        const bin = Math.min(Math.floor(innerX / binWidth), binCount - 1);

        setFocusedBin(bin);
    }, [histXScale, binCount]);
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
    const binLabels = props.columnAggregate.columnAnalysis.binLowerBounds;
    const binLabelLeft = binLabels[0];
    const binLabelRight = binLabels[binLabels.length - 1];
    const binLabelFocused = focusedBin != null ? binLabels[focusedBin] : null;

    // Memoize container style to avoid object recreation
    const containerStyle = React.useMemo(() => ({
        ...props.style,
        zIndex: focusedBin != null ? 100 : props.style?.zIndex
    }), [props.style, focusedBin]);

    // Memoize axis labels container style
    const axisLabelsStyle = React.useMemo(() => ({
        position: "absolute" as const,
        top: `${margin.top + height + 2}px`,
        left: `${margin.left}px`,
        width: `${histWidth}px`,
    }), [margin.top, margin.left, height, histWidth]);

    // Memoize focused label style
    const focusedLabelStyle = React.useMemo(() => {
        if (focusedBin == null) return null;
        return {
            position: "absolute" as const,
            top: `${margin.top + height + 13 - 12}px`,
            left: `${margin.left + (histXScale(focusedBin.toString()) ?? 0) + histXScale.bandwidth() / 2}px`,
            transform: 'translateX(-50%)',
            textWrap: "nowrap" as const,
            fontSize: "12px",
            fontWeight: 400,
            pointerEvents: "none" as const,
            color: "white",
            backgroundColor: "hsl(208.5deg 20.69% 30.76%)",
            zIndex: 3,
            padding: "0px 4px 0px 4px",
            borderRadius: "3px",
        };
    }, [focusedBin, margin.top, margin.left, height, histXScale]);

    // Memoize null label style
    const nullLabelStyle = React.useMemo(() => ({
        position: "absolute" as const,
        top: `${margin.top + height + 2}px`,
        left: `${margin.left + histWidth + nullsMargin + nullsPadding + nullsXScale.bandwidth() / 2}px`,
        transform: 'translateX(-50%)',
        fontSize: "12px",
        fontWeight: 400,
        pointerEvents: "none" as const,
    }), [margin.top, margin.left, height, histWidth, nullsMargin, nullsPadding, nullsXScale]);

    // Memoize focused null label style
    const focusedNullLabelStyle = React.useMemo(() => ({
        top: `${margin.top + height + 13 - 12}px`,
        left: `${margin.left + histWidth + nullsMargin + nullsPadding + nullsXScale.bandwidth() / 2}px`,
    }), [margin.top, margin.left, height, histWidth, nullsMargin, nullsPadding, nullsXScale]);

    return (
        <div
            className={props.className}
            style={containerStyle}
            onClick={clearBrush}
        >
            <div className={styles.root}>
                <div className={styles.header_container}>
                    {focusDescription ?? dataTypeToString(props.columnAggregate.columnEntry.inputFieldType)}
                </div>
                <div className={styles.plot_container} ref={svgContainer}>
                    <svg
                        className={styles.plot_svg}
                        width={width + margin.left + margin.right}
                        height={height + margin.top + margin.bottom}
                    >
                        <g transform={`translate(${margin.left},${margin.top})`}>
                            <g>
                                <HistogramBars
                                    binCounts={binCounts}
                                    filteredBinCounts={filteredBinCounts}
                                    focusedBin={focusedBin}
                                    xScale={histXScale}
                                    yScale={histYScale}
                                    height={height}
                                    totalBarColor={totalBarColor}
                                    totalBarFocusedColor={totalBarFocusedColor}
                                    filteredBarColor={filteredBarColor}
                                    filteredBarFocusedColor={filteredBarFocusedColor}
                                />
                            </g>
                            <g ref={brushContainer}
                                onPointerOver={onPointerOverBin}
                                onPointerMove={onPointerOverBin}
                                onPointerOut={onPointerOutBin}
                                onClick={event => event.stopPropagation()}
                            />
                            <g
                                transform={`translate(0, ${height})`}
                                onPointerOver={onPointerOverBin}
                                onPointerMove={onPointerOverBin}
                                onPointerOut={onPointerOutBin}
                            >
                                <line x1={0} y1={1} x2={histWidth} y2={1}
                                    stroke={"hsl(210deg 17.5% 84.31%)"} />
                                <rect
                                    x={0} y={0}
                                    width={histWidth}
                                    height={margin.bottom - 1}
                                    fillOpacity={0}
                                />
                            </g>
                            {inputNullable && (
                                <HistogramNullBar
                                    countNull={countNull ?? 0}
                                    filteredNullCount={filteredNullCount}
                                    focused={focusedNull}
                                    xScale={nullsXScale}
                                    yScale={nullsYScale}
                                    xWidth={nullsXWidth}
                                    height={height}
                                    bottomMargin={margin.bottom}
                                    transformX={histWidth + nullsMargin + nullsPadding}
                                    totalBarColor={totalNullBarColor}
                                    totalBarFocusedColor={totalNullBarFocusedColor}
                                    filteredBarColor={filteredBarColor}
                                    filteredBarFocusedColor={filteredBarFocusedColor}
                                    onPointerOver={onPointerOverNull}
                                    onPointerOut={onPointerOutNull}
                                />
                            )}
                        </g>

                    </svg>
                    {(binLabelFocused == null)
                        ? (
                            <div
                                className={styles.axis_labels_container}
                                style={axisLabelsStyle}
                            >
                                <span className={styles.axis_label_left}>{binLabelLeft}</span>
                                <span className={styles.axis_label_right} >{binLabelRight}</span>
                            </div>
                        ) : (
                            <span style={focusedLabelStyle!}>{binLabelFocused}</span>
                        )}
                    {inputNullable && (
                        !focusedNull
                            ? (
                                <span style={nullLabelStyle}>{NULL_SYMBOL}</span>

                            ) : (
                                <span className={styles.axis_label_overlay} style={focusedNullLabelStyle}>{NULL_SYMBOL}</span>
                            )
                    )}
                </div>
            </div>
        </div>
    );
};

export const HistogramCell = React.memo(HistogramCellImpl, arePropsEqualWithStyle);
