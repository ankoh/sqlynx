import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_renderer.module.css';

// import { motion } from "framer-motion";
import { classNames } from '../../utils/classnames.js';

/// The rendering settings for a catalog level
export interface CatalogLevelRenderingSettings {
    /// The width of a node
    nodeWidth: number;
    /// The height of a node
    nodeHeight: number;
    /// The maximum children at this level
    maxUnpinnedChildren: number;
    /// The row gap
    rowGap: number;
    /// The column gap left of this entry
    columnGap: number;
}

export interface CatalogRenderingSettings {
    /// The virtualization settings
    virtual: {
        /// The number of prerendered pixels
        prerenderSize: number,
        /// The step size
        stepSize: number,
    },
    /// The rendering levels
    levels: {
        /// The database settings
        databases: CatalogLevelRenderingSettings;
        /// The schema settings
        schemas: CatalogLevelRenderingSettings;
        /// The table settings
        tables: CatalogLevelRenderingSettings;
        /// The column settings
        columns: CatalogLevelRenderingSettings;
    }
}

/// The node rendering mode
enum NodeFlags {
    DEFAULT = 0,
    PINNED = 0b1,
    OVERFLOW = 0b10,
    SCRIPT_FOCUS = 0b100,
    CATALOG_FOCUS = 0b1000,
    DIRECT_FOCUS = 0b10000,
}

/// Helper to get the rendering mode.
function readNodeFlags(modes: Uint8Array, index: number): NodeFlags {
    return (modes[index]) as NodeFlags;
}
/// Helper to set the rendering mode.
function writeNodeFlags(modes: Uint8Array, index: number, node: NodeFlags) {
    modes[index] = node;
}

/// A rendering key
class RenderingKey {
    /// The entries ids
    public entryIds: (number | null)[];
    /// The entry ids string
    private entryIdStrings: (string | null)[];
    /// The first database id?
    public isFirst: boolean[];

    constructor() {
        this.entryIds = [null, null, null, null];
        this.entryIdStrings = [null, null, null, null];
        this.isFirst = [true, true, true, true];
    }
    public reset() {
        this.entryIds = [null, null, null, null];
        this.entryIdStrings = [null, null, null, null];
        this.isFirst = [true, true, true, true];
    }
    public truncate(level: number) {
        for (let i = level + 1; i < 4; ++i) {
            this.entryIdStrings[i] = null;
            this.isFirst[i] = true;
        }
    }
    public select(level: number, id: number) {
        this.isFirst[level] = this.entryIds[level] == null;
        this.entryIds[level] = id;
        this.truncate(level);
    }
    public idToString(level: number): string {
        if (this.entryIdStrings[level] == null) {
            this.entryIdStrings[level] = this.entryIds[level]!.toString();
        }
        return this.entryIdStrings[level];
    }
    public getKeyPrefix(level: number) {
        if (level == 0) {
            return '';
        } else {
            let out = this.entryIds[0]!.toString();
            for (let i = 1; i < level; ++i) {
                out += '-';
                out += this.entryIds[i]!.toString();
            }
            return out;
        }
    }
    public getKey(level: number) {
        let out = this.entryIds[0]!.toString();
        for (let i = 1; i < (level + 1); ++i) {
            out += '-';
            out += this.entryIds[i]!.toString();
        }
        return out;
    }
    public asAttributes(): Record<string, string> {
        const out: Record<string, string> = {};
        for (let i = 0; i < 4; ++i) {
            if (this.entryIds[i] != null) {
                out[`data-level-${i}`] = this.idToString(i);
            }
        }
        return out;
    }
}

/// A span of catalog entries
interface CatalogEntrySpan {
    read(snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry): sqlynx.proto.FlatCatalogEntry | null;
    length(snap: sqlynx.SQLynxCatalogSnapshotReader): number;
}
/// A pinned catalog entry
class PinnedCatalogEntry {
    /// The id in the backing FlatBuffer
    entryId: number;
    /// When rendering this node, what's the height of this subtree?
    renderingHeight: number;
    /// The child pins
    pinnedChildren: PinnedCatalogEntry[];

    constructor(entryId: number) {
        this.entryId = entryId;
        this.renderingHeight = 0;
        this.pinnedChildren = [];
    }
}

interface CatalogLevelRenderingState {
    /// The rendering settings
    settings: CatalogLevelRenderingSettings;
    /// The buffers
    entries: CatalogEntrySpan;
    /// The rendering flags
    flags: Uint8Array;
    /// The subtree heights
    subtreeHeights: Float32Array;
    /// The x offset
    positionX: number;
    /// The scratch element
    scratchEntry: sqlynx.proto.FlatCatalogEntry;
    /// The y positions as written during rendering
    scratchPositionsY: Float32Array;
}

/// A catalog rendering state
export class CatalogRenderingState {
    /// The snapshot.
    /// We have to recreate the state for every new snapshot.
    snapshot: sqlynx.SQLynxCatalogSnapshot;
    /// The rendering settings
    settings: CatalogRenderingSettings;

    /// The levels
    levels: CatalogLevelRenderingState[];
    /// The pinned databases
    pinnedDatabases: PinnedCatalogEntry[];
    /// The total height of all nodes
    totalHeight: number;
    /// The total width of all nodes
    totalWidth: number;

    /// The current writer
    currentWriterY: number;
    /// The current rendering key
    currentRenderingPath: RenderingKey;
    /// The current virtual rendering stack
    currentRenderingWindow: ScrollRenderingWindow;

    constructor(snapshot: sqlynx.SQLynxCatalogSnapshot, settings: CatalogRenderingSettings) {
        this.snapshot = snapshot;
        this.settings = settings;
        const snap = snapshot.read();
        this.levels = [
            {
                settings: settings.levels.databases,
                entries: {
                    read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.databases(index, obj),
                    length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.databasesLength(),
                },
                flags: new Uint8Array(snap.catalogReader.databasesLength()),
                subtreeHeights: new Float32Array(snap.catalogReader.databasesLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snap.catalogReader.databasesLength()),
            },
            {
                settings: settings.levels.schemas,
                entries: {
                    read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.schemas(index, obj),
                    length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.schemasLength(),
                },
                flags: new Uint8Array(snap.catalogReader.schemasLength()),
                subtreeHeights: new Float32Array(snap.catalogReader.schemasLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snap.catalogReader.schemasLength()),
            },
            {
                settings: settings.levels.tables,
                entries: {
                    read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.tables(index, obj),
                    length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.tablesLength(),
                },
                flags: new Uint8Array(snap.catalogReader.tablesLength()),
                subtreeHeights: new Float32Array(snap.catalogReader.tablesLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snap.catalogReader.tablesLength()),
            },
            {
                settings: settings.levels.columns,
                entries: {
                    read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.columns(index, obj),
                    length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.columnsLength(),
                },
                flags: new Uint8Array(snap.catalogReader.columnsLength()),
                subtreeHeights: new Float32Array(snap.catalogReader.columnsLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snap.catalogReader.columnsLength()),
            }
        ];
        this.levels[1].positionX = settings.levels.databases.nodeWidth + settings.levels.databases.columnGap;
        this.levels[2].positionX = this.levels[1].positionX + settings.levels.schemas.nodeWidth + settings.levels.schemas.columnGap;
        this.levels[3].positionX = this.levels[2].positionX + settings.levels.tables.nodeWidth + settings.levels.tables.columnGap;

        this.pinnedDatabases = [];
        this.totalWidth = 0;
        this.totalHeight = 0;
        this.currentWriterY = 0;
        this.currentRenderingPath = new RenderingKey();
        this.currentRenderingWindow = new ScrollRenderingWindow();

        // Layout all entries.
        // This means users don't have to special-case the states without layout.
        this.layoutEntries();
    }

    layoutEntries() {
        const snap = this.snapshot.read();
        const databaseCount = this.levels[0].entries.length(snap);
        layoutEntries(this, snap, 0, 0, databaseCount);
        this.totalHeight = this.currentWriterY;
        this.totalWidth = this.levels[3].positionX + this.settings.levels.columns.nodeWidth + this.settings.levels.columns.columnGap;
    }

    resetWriter() {
        this.currentWriterY = 0;
        this.currentRenderingPath.reset();
        for (const level of this.levels) {
            level.scratchPositionsY.fill(NaN);
        }
    }
    updateWindow(begin: number, end: number, virtualBegin: number, virtualEnd: number) {
        this.currentRenderingWindow.updateWindow(begin, end, virtualBegin, virtualEnd);
    }
}

/// Layout unpinned entries and assign them NodeFlags
function layoutEntries(state: CatalogRenderingState, snapshot: sqlynx.SQLynxCatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchEntry = state.levels[level].scratchEntry;
    const subtreeHeights = state.levels[level].subtreeHeights;
    const flags = state.levels[level].flags;

    let unpinnedChildCount = 0;
    let overflowChildCount = 0;

    for (let i = 0; i < entriesCount; ++i) {
        const entryId = entriesBegin + i;
        const entry = entries.read(snapshot, entryId, scratchEntry)!;
        const entryFlags = readNodeFlags(flags, entryId);

        // PINNED and DEFAULT entries have the same height, so it doesn't matter that we're accounting for them here in the "wrong" order.

        // Skip the node if the node is UNPINNED and the child count hit the limit
        if ((entryFlags & NodeFlags.PINNED) == 0) {
            ++unpinnedChildCount;
            if (unpinnedChildCount > settings.maxUnpinnedChildren) {
                ++overflowChildCount;
                writeNodeFlags(flags, entryId, NodeFlags.OVERFLOW);
                continue;
            }
        }

        // Update level stack
        state.currentRenderingPath.select(level, entryId);
        const isFirstEntry = state.currentRenderingPath.isFirst[level];
        // The begin of the subtree
        let subtreeBegin = state.currentWriterY;
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Render child columns
        if (entry.childCount() > 0) {
            layoutEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount());
        }
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        // Truncate the rendering path
        state.currentRenderingPath.truncate(level);
        // Store the subtree height
        subtreeHeights[entryId] = state.currentWriterY - subtreeBegin;
    }

    // Add space for the overflow node
    if (overflowChildCount > 0) {
        state.currentWriterY += settings.rowGap;
        state.currentWriterY += settings.nodeHeight;
    }
}

class ScrollRenderingStatistics {
    /// Minimum position in the scroll window
    minInScrollWindow: number;
    /// Maximum position in the scroll window
    maxInScrollWindow: number;

    constructor(tracker: ScrollRenderingWindow) {
        this.minInScrollWindow = tracker.scrollWindowEnd;
        this.maxInScrollWindow = tracker.scrollWindowBegin;
    }
    reset(tracker: ScrollRenderingWindow) {
        this.minInScrollWindow = tracker.scrollWindowEnd;
        this.maxInScrollWindow = tracker.scrollWindowBegin;
    }
    centerInScrollWindow(): number | null {
        if (this.minInScrollWindow <= this.maxInScrollWindow) {
            return this.minInScrollWindow + (this.maxInScrollWindow - this.minInScrollWindow) / 2;
        } else {
            return null;
        }
    }
}

class ScrollRenderingWindow {
    /// The begin offset of the actual scroll window
    scrollWindowBegin: number;
    /// The end offset of the actual scroll window
    scrollWindowEnd: number;
    /// The begin offset of the virtual scroll window
    virtualScrollWindowBegin: number;
    /// The end offset of the virtual scroll window
    virtualScrollWindowEnd: number;
    /// The statistics count
    statisticsCount: number;
    /// The rendering boundaries
    statistics: ScrollRenderingStatistics[]

    constructor() {
        this.scrollWindowBegin = 0;
        this.scrollWindowEnd = 0;
        this.virtualScrollWindowBegin = 0;
        this.virtualScrollWindowEnd = 0;
        this.statisticsCount = 1;
        this.statistics = [
            new ScrollRenderingStatistics(this),
            new ScrollRenderingStatistics(this),
            new ScrollRenderingStatistics(this),
            new ScrollRenderingStatistics(this),
            new ScrollRenderingStatistics(this),
        ];
    }
    updateWindow(begin: number, end: number, virtualBegin: number, virtualEnd: number) {
        this.scrollWindowBegin = begin;
        this.scrollWindowEnd = end;
        this.virtualScrollWindowBegin = virtualBegin;
        this.virtualScrollWindowEnd = virtualEnd;
    }
    startRenderingChildren() {
        this.statistics[this.statisticsCount].reset(this);
        ++this.statisticsCount;
    }
    stopRenderingChildren(): ScrollRenderingStatistics {
        return this.statistics[--this.statisticsCount];
    }
    addNode(pos: number, height: number) {
        const stats = this.statistics[this.statisticsCount - 1];
        const begin = pos;
        const end = pos + height;
        if (end > this.scrollWindowBegin && begin < this.scrollWindowEnd) {
            stats.minInScrollWindow = Math.min(stats.minInScrollWindow, begin);
            stats.maxInScrollWindow = Math.max(stats.maxInScrollWindow, end);
        }
    }
}

/// Render unpinned entries and emit ReactElements if they are within the virtual scroll window
function renderUnpinnedEntries(state: CatalogRenderingState, snapshot: sqlynx.SQLynxCatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number, outNodes: React.ReactElement[]) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchPositions = state.levels[level].scratchPositionsY;
    const scratchEntry = state.levels[level].scratchEntry;
    const flags = state.levels[level].flags;
    const positionX = state.levels[level].positionX;

    // Track overflow nodes
    let overflowChildCount = 0;
    let lastOverflowEntryId = 0;

    for (let i = 0; i < entriesCount; ++i) {
        // Resolve table
        const entryId = entriesBegin + i;
        const entry = entries.read(snapshot, entryId, scratchEntry)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Skip pinned entries
        if ((entryFlags & NodeFlags.PINNED) != 0) {
            continue;
        }
        // Skip overflow entries
        if ((entryFlags & NodeFlags.OVERFLOW) != 0) {
            ++overflowChildCount;
            lastOverflowEntryId = entryId;
            continue;
        }
        // Update level stack
        state.currentRenderingPath.select(level, entryId);
        const isFirstEntry = state.currentRenderingPath.isFirst[level];
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Render children
        let centerInScrollWindow: number | null = null;
        if (entry.childCount() > 0) {
            state.currentRenderingWindow.startRenderingChildren();
            renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes);
            const stats = state.currentRenderingWindow.stopRenderingChildren();
            centerInScrollWindow = stats.centerInScrollWindow();
        }
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        // Truncate any stack items that children added
        state.currentRenderingPath.truncate(level);
        // Vertically center the node over all child nodes
        thisPosY = centerInScrollWindow == null ? thisPosY : (centerInScrollWindow - settings.nodeHeight / 2);
        // Break if lower bound is larger than virtual window
        if (thisPosY >= state.currentRenderingWindow.virtualScrollWindowEnd) {
            break;
        }
        // Skip if upper bound is smaller than virtual window
        if (state.currentWriterY < state.currentRenderingWindow.virtualScrollWindowBegin) {
            continue;
        }
        // Remember the node position
        state.currentRenderingWindow.addNode(thisPosY, settings.nodeHeight);
        scratchPositions[entryId] = thisPosY;
        // Output column node
        const tableKey = state.currentRenderingPath.getKey(level);
        const tableName = snapshot.readName(entry.nameId());
        outNodes.push(
            <div
                key={tableKey}
                // layoutId={tableKey}
                className={classNames(styles.node_default, {
                    [styles.node_focus_script]: (entryFlags & NodeFlags.SCRIPT_FOCUS) != 0,
                    [styles.node_focus_catalog]: (entryFlags & NodeFlags.CATALOG_FOCUS) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeFlags.DIRECT_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeFlags.PINNED) != 0,
                })}
                style={{
                    position: 'absolute',
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                {...state.currentRenderingPath.asAttributes()}
            >
                {tableName}
            </div>
        );
    }

    // Render overflow entry
    if (overflowChildCount > 0) {
        state.currentWriterY += settings.rowGap;
        const thisPosY = state.currentWriterY;
        state.currentWriterY += settings.nodeHeight;

        if (state.currentWriterY > state.currentRenderingWindow.virtualScrollWindowBegin && thisPosY < state.currentRenderingWindow.virtualScrollWindowEnd) {
            state.currentRenderingWindow.addNode(thisPosY, settings.nodeHeight);
            scratchPositions[lastOverflowEntryId] = thisPosY;
            const overflowKey = `${state.currentRenderingPath.getKeyPrefix(level)}-overflow`;
            outNodes.push(
                <div
                    key={overflowKey}
                    // layoutId={overflowKey}
                    className={classNames(styles.node_default, styles.node_overflow)}
                    style={{
                        position: 'absolute',
                        top: thisPosY,
                        left: positionX,
                        width: settings.nodeWidth,
                        height: settings.nodeHeight,
                    }}
                    {...state.currentRenderingPath.asAttributes()}
                >
                    {overflowChildCount}
                </div>
            );
        }
    }
}

/// A function to render entries
function renderPinnedEntries(state: CatalogRenderingState, snapshot: sqlynx.SQLynxCatalogSnapshotReader, level: number, pinnedEntries: PinnedCatalogEntry[], outNodes: React.ReactElement[]) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchEntry = state.levels[level].scratchEntry;
    const scratchPositions = state.levels[level].scratchPositionsY;
    const flags = state.levels[level].flags;
    const positionX = state.levels[level].positionX;

    for (const pinnedEntry of pinnedEntries) {
        // Resolve table
        const entryId = pinnedEntry.entryId;
        const entry = entries.read(snapshot, pinnedEntry.entryId, scratchEntry)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Update level stack
        state.currentRenderingPath.select(level, entryId);
        const isFirstEntry = state.currentRenderingPath.isFirst[level];
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Add a new scrope for the virtual boundaries
        state.currentRenderingWindow.startRenderingChildren();
        // First render all pinned children
        if (pinnedEntry.pinnedChildren.length > 0) {
            renderPinnedEntries(state, snapshot, level + 1, pinnedEntry.pinnedChildren, outNodes);
        }
        // Then render all unpinned entries
        if (entry.childCount() > 0) {
            renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes);
        }
        // Get the child statistics
        const childStatistics = state.currentRenderingWindow.stopRenderingChildren();
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        // Truncate the rendering path
        state.currentRenderingPath.truncate(level);
        // Vertically center the node over all child nodes
        const centerInScrollWindow = childStatistics.centerInScrollWindow();
        thisPosY = centerInScrollWindow == null ? thisPosY : (centerInScrollWindow - settings.nodeHeight / 2);
        // Break if lower bound is larger than virtual window
        if (thisPosY >= state.currentRenderingWindow.virtualScrollWindowEnd) {
            break;
        }
        // Skip if upper bound is smaller than virtual window
        if (state.currentWriterY < state.currentRenderingWindow.virtualScrollWindowBegin) {
            continue;
        }
        // Remember rendered position
        state.currentRenderingWindow.addNode(thisPosY, settings.nodeHeight);
        scratchPositions[entryId] = thisPosY;
        // Output column node
        const tableKey = state.currentRenderingPath.getKey(level);
        const tableName = snapshot.readName(entry.nameId());
        outNodes.push(
            <div
                key={tableKey}
                // layoutId={tableKey}
                className={classNames(styles.node_default, {
                    [styles.node_focus_script]: (entryFlags & NodeFlags.SCRIPT_FOCUS) != 0,
                    [styles.node_focus_catalog]: (entryFlags & NodeFlags.CATALOG_FOCUS) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeFlags.DIRECT_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeFlags.PINNED) != 0,
                })}
                style={{
                    position: 'absolute',
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                {...state.currentRenderingPath.asAttributes()}
            >
                {tableName}
            </div>
        );
    }
}

/// Layout the catalog
export function layoutCatalog(state: CatalogRenderingState) {
    const snap = state.snapshot.read();
    layoutEntries(state, snap, 0, 0, state.levels[0].entries.length(snap));
}

/// A function to render a catalog
export function renderCatalog(state: CatalogRenderingState): React.ReactElement[] {
    const out: React.ReactElement[] = [];
    const snap = state.snapshot.read();

    // Reset the rendering
    state.resetWriter();
    // First, render the pinned databases
    renderPinnedEntries(state, snap, 0, state.pinnedDatabases, out);
    // Then render the unpinned databases
    renderUnpinnedEntries(state, snap, 0, 0, state.levels[0].entries.length(snap), out);
    return out;
}
