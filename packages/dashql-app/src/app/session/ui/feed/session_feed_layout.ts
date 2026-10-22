import * as React from 'react';

import { useListRef } from 'react-window';

import { observeSize } from '../../../../ui/foundations/size_observer.js';
import { useScrollbarWidth } from '../../../../utils/scrollbar.js';

interface FeedLayoutEntry {
    scriptId: number;
    estimatedHeight: number;
}

const SEPARATOR_HEIGHT = 40;
const FIRST_SEPARATOR_HEIGHT = 48;

export class FeedRowHeightCache {
    private readonly measuredHeights = new Map<number, number>();

    constructor(
        private entries: FeedLayoutEntry[],
        private readonly onChange: (index: number, previousHeight: number, height: number) => void = () => {},
        private firstSeparatorHeight = FIRST_SEPARATOR_HEIGHT,
        private bottomInset = 0,
    ) {}

    updateEntries(entries: FeedLayoutEntry[], firstSeparatorHeight = this.firstSeparatorHeight, bottomInset = this.bottomInset) {
        this.entries = entries;
        this.firstSeparatorHeight = firstSeparatorHeight;
        this.bottomInset = bottomInset;
    }

    getAverageRowHeight() {
        if (this.entries.length === 0) return SEPARATOR_HEIGHT;
        const totalEntryHeight = this.entries.reduce((total, entry) => (
            total + (this.measuredHeights.get(entry.scriptId) ?? entry.estimatedHeight)
        ), 0);
        const totalSeparatorHeight = this.firstSeparatorHeight + this.entries.length * SEPARATOR_HEIGHT + this.bottomInset;
        return (totalEntryHeight + totalSeparatorHeight) / (this.entries.length * 2 + 1);
    }

    getRowHeight(index: number) {
        if (index % 2 === 0) {
            // The last separator carries the space below the script that the docked composer floats over
            const bottomInset = index === this.entries.length * 2 ? this.bottomInset : 0;
            return (index === 0 ? this.firstSeparatorHeight : SEPARATOR_HEIGHT) + bottomInset;
        }
        const entry = this.entries[Math.floor(index / 2)];
        return entry == null ? undefined : this.measuredHeights.get(entry.scriptId) ?? entry.estimatedHeight;
    }

    setRowHeight = (index: number, height: number) => {
        const entry = index % 2 === 1 ? this.entries[Math.floor(index / 2)] : null;
        if (entry == null) return;
        const previousHeight = this.measuredHeights.get(entry.scriptId) ?? entry.estimatedHeight;
        if (previousHeight === height) return;
        this.measuredHeights.set(entry.scriptId, height);
        this.onChange(index, previousHeight, height);
    };

    observeRowElements() {
        return () => {};
    }
}

export function useSessionFeedLayout(entries: FeedLayoutEntry[], firstSeparatorHeight = FIRST_SEPARATOR_HEIGHT, bottomInset = 0) {
    const listContainerRef = React.useRef<HTMLDivElement>(null);
    const listRef = useListRef(null);
    const [heightsVersion, setHeightsVersion] = React.useState(0);
    const rowHeightsRef = React.useRef<FeedRowHeightCache | null>(null);
    if (rowHeightsRef.current == null) {
        rowHeightsRef.current = new FeedRowHeightCache(entries, () => {
            setHeightsVersion(version => version + 1);
        }, firstSeparatorHeight, bottomInset);
    }
    rowHeightsRef.current.updateEntries(entries, firstSeparatorHeight, bottomInset);
    const rowHeightCache = rowHeightsRef.current;
    const rowHeights = React.useMemo(() => ({
        getAverageRowHeight: () => rowHeightCache.getAverageRowHeight(),
        getRowHeight: (index: number) => rowHeightCache.getRowHeight(index),
        setRowHeight: rowHeightCache.setRowHeight,
        observeRowElements: () => () => {},
    }), [rowHeightCache, heightsVersion, firstSeparatorHeight, bottomInset]);
    const listContainerSize = observeSize(listContainerRef);
    const listWidth = listContainerSize?.width ?? 0;
    const listHeight = listContainerSize?.height ?? 0;
    const listScrollbarInset = useScrollbarWidth();

    return {
        listContainerRef,
        listRef,
        rowHeights,
        rowHeightsVersion: heightsVersion,
        listWidth,
        listHeight,
        listScrollbarInset,
    };
}
