import * as React from 'react';
import * as d3 from 'd3';

export const NULL_SYMBOL = "∅";

interface BarGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

function getBarGeometry(
    bin: number,
    count: bigint,
    xScale: d3.ScaleBand<string>,
    yScale: d3.ScaleLinear<number, number>,
    height: number,
): BarGeometry | null {
    const x = xScale(bin.toString());
    const y = yScale(Number(count));
    const width = xScale.bandwidth();
    const barHeight = height - y;
    if (x == null || isNaN(y) || isNaN(width) || isNaN(barHeight)) return null;
    return { x, y, width, height: barHeight };
}

interface HistogramBarsProps {
    binCounts: BigInt64Array;
    filteredBinCounts: BigInt64Array | null;
    focusedBin: number | null;
    xScale: d3.ScaleBand<string>;
    yScale: d3.ScaleLinear<number, number>;
    height: number;
    totalBarColor: string;
    totalBarFocusedColor: string;
    filteredBarColor: string;
    filteredBarFocusedColor: string;
}

function HistogramBarsImpl(props: HistogramBarsProps): React.ReactElement {
    const filteredBinCounts = props.filteredBinCounts;
    const totalBars = Array.from({ length: props.binCounts.length }, (_, bin) => {
        const geometry = getBarGeometry(bin, props.binCounts[bin], props.xScale, props.yScale, props.height);
        return geometry == null ? null : <rect key={bin} {...geometry} fill={props.totalBarColor} />;
    });
    const focusedTotalGeometry = props.focusedBin == null
        ? null
        : getBarGeometry(props.focusedBin, props.binCounts[props.focusedBin], props.xScale, props.yScale, props.height);
    const filteredBars = filteredBinCounts == null
        ? null
        : Array.from({ length: filteredBinCounts.length }, (_, bin) => {
            const geometry = getBarGeometry(bin, filteredBinCounts[bin], props.xScale, props.yScale, props.height);
            return geometry == null ? null : <rect key={`filtered-${bin}`} {...geometry} fill={props.filteredBarColor} />;
        });
    const focusedFilteredGeometry = props.focusedBin == null || filteredBinCounts == null
        ? null
        : getBarGeometry(props.focusedBin, filteredBinCounts[props.focusedBin], props.xScale, props.yScale, props.height);

    return (
        <>
            {totalBars}
            {focusedTotalGeometry != null && (
                <rect key={`focused-${props.focusedBin}`} {...focusedTotalGeometry} fill={props.totalBarFocusedColor} />
            )}
            {filteredBars}
            {focusedFilteredGeometry != null && (
                <rect key={`focused-filtered-${props.focusedBin}`} {...focusedFilteredGeometry} fill={props.filteredBarFocusedColor} />
            )}
        </>
    );
}

export const HistogramBars = React.memo(HistogramBarsImpl);

interface HistogramNullBarProps {
    countNull: number;
    filteredNullCount: number | null;
    focused: boolean | null;
    xScale: d3.ScaleBand<string>;
    yScale: d3.ScaleLinear<number, number>;
    xWidth: number;
    height: number;
    bottomMargin: number;
    transformX: number;
    totalBarColor: string;
    totalBarFocusedColor: string;
    filteredBarColor: string;
    filteredBarFocusedColor: string;
    onPointerOver: React.MouseEventHandler<SVGGElement>;
    onPointerOut: React.MouseEventHandler<SVGGElement>;
}

export function HistogramNullBar(props: HistogramNullBarProps): React.ReactElement | null {
    const nullX = props.xScale(NULL_SYMBOL);
    const nullY = props.yScale(props.countNull);
    const nullWidth = props.xScale.bandwidth();
    const nullHeight = props.height - nullY;
    if (nullX == null || isNaN(nullY) || isNaN(nullWidth) || isNaN(nullHeight)) return null;

    const filteredNullY = props.filteredNullCount == null ? null : props.yScale(props.filteredNullCount);
    const filteredNullHeight = filteredNullY == null ? null : props.height - filteredNullY;
    const hasValidFilteredBar = filteredNullY != null
        && filteredNullHeight != null
        && !isNaN(filteredNullY)
        && !isNaN(filteredNullHeight);

    return (
        <g
            transform={`translate(${props.transformX}, 0)`}
            onPointerOver={props.onPointerOver}
            onPointerMove={props.onPointerOver}
            onPointerOut={props.onPointerOut}
        >
            <rect
                x={nullX}
                y={nullY}
                width={nullWidth}
                height={nullHeight}
                fill={props.focused ? props.totalBarFocusedColor : props.totalBarColor}
            />
            {hasValidFilteredBar && (
                <rect
                    x={nullX}
                    y={filteredNullY!}
                    width={nullWidth}
                    height={filteredNullHeight!}
                    fill={props.focused ? props.filteredBarFocusedColor : props.filteredBarColor}
                />
            )}
            <g transform={`translate(0, ${props.height})`}>
                <line
                    x1={0} y1={1}
                    x2={props.xWidth} y2={1}
                    stroke={'hsl(210deg 17.5% 84.31%)'}
                />
                <rect
                    x={nullX}
                    y={0}
                    width={nullWidth}
                    height={props.bottomMargin}
                    fillOpacity={0}
                />
            </g>
        </g>
    );
}
