// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { rgb } from "d3-color";

const category10 = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
];

const category20 = [
    "#1f77b4",
    "#aec7e8",
    "#ff7f0e",
    "#ffbb78",
    "#2ca02c",
    "#98df8a",
    "#d62728",
    "#ff9896",
    "#9467bd",
    "#c5b0d5",
    "#8c564b",
    "#c49c94",
    "#e377c2",
    "#f7b6d2",
    "#7f7f7f",
    "#c7c7c7",
    "#bcbd22",
    "#dbdb8d",
    "#17becf",
    "#9edae5",
];

export function defaultCategoryColors(count: number): string[] {
    if (count < 1) {
        count = 1;
    }
    if (count <= category10.length) {
        return category10.slice(0, count);
    } else if (count <= category20.length) {
        return category20.slice(0, count);
    } else {
        let colors: string[] = [];
        for (let i = 0; i < count; i++) {
            colors[i] = category20[i % category20.length];
        }
        return colors;
    }
}

/** Parse color string into normalized sRGB values (all between 0 and 1). */
export function parseColorNormalizedRgb(str: string): { r: number; g: number; b: number; a: number } {
    let { r, g, b, opacity } = rgb(str);
    return { r: r / 255.0, g: g / 255.0, b: b / 255.0, a: opacity };
}
