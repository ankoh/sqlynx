import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_renderer.module.css';

import { motion } from "framer-motion";
import { classNames } from '../../utils/classnames.js';
import { CatalogSnapshot, CatalogSnapshotReader } from '../../connectors/catalog_snapshot.js';

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
    /// The database settings
    databases: CatalogLevelRenderingSettings;
    /// The schema settings
    schemas: CatalogLevelRenderingSettings;
    /// The table settings
    tables: CatalogLevelRenderingSettings;
    /// The column settings
    columns: CatalogLevelRenderingSettings;
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

/// A rendering stack
class CatalogRenderingStack {
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
        this.isFirst[level] = this.entryIds[level] != null;
        this.entryIds[level] = id;
        this.truncate(level);
    }
    public idToString(level: number): string {
        if (this.entryIdStrings[level] == null) {
            this.entryIdStrings[level] = this.entryIds[level]!.toString();
        }
        return this.entryIdStrings[level];
    }
    public getKey(level: number) {
        let out = '';
        out += this.entryIds[0]!.toString();
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
                out[`data-l${i}`] = this.idToString(i);
            }
        }
        return out;
    }
}

/// A span of catalog entries
interface CatalogEntrySpan {
    read(index: number, obj?: sqlynx.proto.FlatCatalogEntry): sqlynx.proto.FlatCatalogEntry | null;
    length(): number;
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
class CatalogRenderingState {
    /// The levels
    levels: CatalogLevelRenderingState[];

    /// The pinned databases
    pinnedDatabases: PinnedCatalogEntry[];

    /// The offset of the virtual window
    virtualWindowBegin: number;
    /// The offset of the virtual window
    virtualWindowEnd: number;

    /// The current writer
    currentWriterY: number;
    /// The current rendering path
    currentLevelStack: CatalogRenderingStack;

    constructor(snapshot: CatalogSnapshotReader, settings: CatalogRenderingSettings) {
        this.levels = [
            {
                settings: settings.databases,
                entries: {
                    read: (index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snapshot.catalogReader.databases(index, obj),
                    length: () => snapshot.catalogReader.databasesLength(),
                },
                flags: new Uint8Array(snapshot.catalogReader.databasesLength()),
                subtreeHeights: new Float32Array(snapshot.catalogReader.databasesLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snapshot.catalogReader.databasesLength()),
            },
            {
                settings: settings.schemas,
                entries: {
                    read: (index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snapshot.catalogReader.schemas(index, obj),
                    length: () => snapshot.catalogReader.schemasLength(),
                },
                flags: new Uint8Array(snapshot.catalogReader.schemasLength()),
                subtreeHeights: new Float32Array(snapshot.catalogReader.schemasLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snapshot.catalogReader.schemasLength()),
            },
            {
                settings: settings.tables,
                entries: {
                    read: (index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snapshot.catalogReader.tables(index, obj),
                    length: () => snapshot.catalogReader.tablesLength(),
                },
                flags: new Uint8Array(snapshot.catalogReader.tablesLength()),
                subtreeHeights: new Float32Array(snapshot.catalogReader.tablesLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snapshot.catalogReader.tablesLength()),
            },
            {
                settings: settings.columns,
                entries: {
                    read: (index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snapshot.catalogReader.columns(index, obj),
                    length: () => snapshot.catalogReader.columnsLength(),
                },
                flags: new Uint8Array(snapshot.catalogReader.columnsLength()),
                subtreeHeights: new Float32Array(snapshot.catalogReader.columnsLength()),
                positionX: 0,
                scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
                scratchPositionsY: new Float32Array(snapshot.catalogReader.columnsLength()),
            }
        ];
        this.levels[1].positionX = settings.databases.nodeWidth + settings.databases.columnGap;
        this.levels[2].positionX = this.levels[1].positionX + settings.schemas.nodeWidth + settings.schemas.columnGap;
        this.levels[3].positionX = this.levels[2].positionX + settings.tables.nodeWidth + settings.tables.columnGap;

        this.pinnedDatabases = [];

        this.virtualWindowBegin = 0;
        this.virtualWindowEnd = 0;
        this.virtualWindowEnd = 0;

        this.currentWriterY = 0;
        this.currentLevelStack = new CatalogRenderingStack();
    }

    resetWriter() {
        this.currentWriterY = 0;
        this.currentLevelStack.reset();
        for (const level of this.levels) {
            level.scratchPositionsY.fill(NaN);
        }
    }
    moveVirtualWindow(windowBegin: number, windowSize: number) {
        this.virtualWindowBegin = windowBegin;
        this.virtualWindowEnd = windowBegin + windowSize;
    }
}

/// Layout unpinned entries and assign them NodeFlags
function layoutEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchEntry = state.levels[level].scratchEntry;
    const flags = state.levels[level].flags;

    let unpinnedChildCount = 0;
    let overflowChildCount = 0;

    for (let i = 0; i < entriesCount; ++i) {
        const entryId = entriesBegin + i;
        const entry = entries.read(entryId, scratchEntry)!;
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
        state.currentLevelStack.select(level, entryId);
        const isFirstEntry = state.currentLevelStack.isFirst[level];
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Render child columns
        layoutEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount());
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        state.currentLevelStack.truncate(level);
    }

    // Add space for the overflow node
    if (overflowChildCount > 0) {
        state.currentWriterY += settings.rowGap;
        state.currentWriterY += settings.nodeHeight;
    }
}

/// Render unpinned entries and emit ReactElements if they are within the virtual scroll window
function renderUnpinnedEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number, outNodes: React.ReactElement[]) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchPositions = state.levels[level].scratchPositionsY;
    const scratchEntry = state.levels[level].scratchEntry;
    const flags = state.levels[level].flags;
    const positionX = state.levels[level].positionX;

    for (let i = 0; i < entriesCount; ++i) {
        const entryId = entriesBegin + i;
        // Resolve table
        const entry = entries.read(entryId, scratchEntry)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Skip pinned and overflow entries
        if ((entryFlags & (NodeFlags.PINNED | NodeFlags.OVERFLOW)) != 0) {
            continue;
        }
        // Update level stack
        state.currentLevelStack.select(level, entryId);
        const isFirstEntry = state.currentLevelStack.isFirst[level];
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Render child columns
        renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes);
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        state.currentLevelStack.truncate(level);
        // Vertically center the node over all child nodes
        thisPosY += (state.currentWriterY - thisPosY) / 2 - settings.nodeHeight / 2;
        // Break if lower bound is larger than virtual window
        if (thisPosY >= state.virtualWindowEnd) {
            break;
        }
        // Skip if upper bound is smaller than virtual window
        if (state.currentWriterY < state.virtualWindowBegin) {
            continue;
        }
        // When emitting the node, also remember the node position so that the parent can draw an edge
        scratchPositions[entryId] = thisPosY;
        // Output column node
        const tableName = snapshot.readName(entry.nameId());
        const tableKey = state.currentLevelStack.getKey(level);
        outNodes.push(
            <motion.div
                key={tableKey}
                layoutId={tableKey}
                className={classNames(styles.node_default, {
                    [styles.node_focus_script]: (entryFlags & NodeFlags.SCRIPT_FOCUS) != 0,
                    [styles.node_focus_catalog]: (entryFlags & NodeFlags.CATALOG_FOCUS) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeFlags.DIRECT_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeFlags.PINNED) != 0,
                })}
                style={{
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                {...state.currentLevelStack.asAttributes()}
            >
                {tableName}
            </motion.div>
        );
    }
}

/// A function to render entries
function renderPinnedEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, pinnedEntries: PinnedCatalogEntry[], outNodes: React.ReactElement[]) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchEntry = state.levels[level].scratchEntry;
    const scratchPositions = state.levels[level].scratchPositionsY;
    const flags = state.levels[level].flags;
    const positionX = state.levels[level].positionX;

    for (const pinnedEntry of pinnedEntries) {
        // Resolve table
        const entryId = pinnedEntry.entryId;
        const entry = entries.read(pinnedEntry.entryId, scratchEntry)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Update level stack
        state.currentLevelStack.select(level, entryId);
        const isFirstEntry = state.currentLevelStack.isFirst[level];
        // Add row gap when first
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // First render all pinned children
        renderPinnedEntries(state, snapshot, level + 1, pinnedEntry.pinnedChildren, outNodes);
        // Then render all unpinned entries
        renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes);
        // Bump writer if the columns didn't already
        state.currentWriterY = Math.max(state.currentWriterY, thisPosY + settings.nodeHeight);
        state.currentLevelStack.truncate(level);
        // Vertically center the node over all child nodes
        thisPosY += (state.currentWriterY - thisPosY) / 2 - settings.nodeHeight / 2;
        // Break if lower bound is larger than virtual window
        if (thisPosY >= state.virtualWindowEnd) {
            break;
        }
        // Skip if upper bound is smaller than virtual window
        if (state.currentWriterY < state.virtualWindowBegin) {
            continue;
        }
        scratchPositions[entryId] = thisPosY;
        // Output column node
        const tableName = snapshot.readName(entry.nameId());
        const tableKey = state.currentLevelStack.getKey(level);
        outNodes.push(
            <motion.div
                key={tableKey}
                layoutId={tableKey}
                className={classNames(styles.node_default, {
                    [styles.node_focus_script]: (entryFlags & NodeFlags.SCRIPT_FOCUS) != 0,
                    [styles.node_focus_catalog]: (entryFlags & NodeFlags.CATALOG_FOCUS) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeFlags.DIRECT_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeFlags.PINNED) != 0,
                })}
                style={{
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                {...state.currentLevelStack.asAttributes()}
            >
                {tableName}
            </motion.div>
        );
    }
}

/// Layout the catalog
export function layoutCatalog(state: CatalogRenderingState, catalog: CatalogSnapshot) {
    const snapshot = catalog.read();
    layoutEntries(state, snapshot, 0, 0, state.levels[0].entries.length());
}

/// A function to render a catalog
export function renderCatalog(state: CatalogRenderingState, catalog: CatalogSnapshot): React.ReactElement[] {
    const snapshot = catalog.read();
    const out: React.ReactElement[] = [];

    // Reset the rendering
    state.resetWriter();
    // First, render the pinned databases
    renderPinnedEntries(state, snapshot, 0, state.pinnedDatabases, out);
    // Then render the unpinned databases
    renderUnpinnedEntries(state, snapshot, 0, 0, state.levels[0].entries.length(), out);
    return out;
}
