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
/// A catalog rendering state
interface CatalogRenderingState {
    /// The offset of the virtual window
    virtualWindowBegin: number;
    /// The offset of the virtual window
    virtualWindowEnd: number;

    /// The level rendering settings
    levelSettings: CatalogLevelRenderingSettings[];
    /// The level buffers
    levelBuffers: CatalogEntrySpan[];
    /// The level scratch buffers
    levelScratchBuffers: sqlynx.proto.FlatCatalogEntry[];
    /// The level node flags
    levelNodeFlags: Uint8Array[];
    /// The level offsets
    levelOffsetsX: number[];

    /// The pinned databases
    pinnedDatabases: PinnedCatalogEntry[];

    /// The current writer
    currentWriterY: number;
    /// The current rendering path
    currentLevelStack: CatalogRenderingStack;
}

/// Layout unpinned entries and assign them NodeFlags
function layoutEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number) {
    const entries = state.levelBuffers[level];
    const scratchBuffer = state.levelScratchBuffers[level];
    const flags = state.levelNodeFlags[level];
    const settings = state.levelSettings[level];

    let unpinnedChildCount = 0;
    let overflowChildCount = 0;

    for (let i = 0; i < entriesCount; ++i) {
        const entryId = entriesBegin + i;
        const entry = entries.read(entryId, scratchBuffer)!;
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
        const thisPosY = state.currentWriterY;
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
function renderUnpinnedEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number, out: React.ReactElement[]) {
    const entries = state.levelBuffers[level];
    const scratch = state.levelScratchBuffers[level];
    const flags = state.levelNodeFlags[level];

    for (let i = 0; i < entriesCount; ++i) {
        const entryId = entriesBegin + i;
        // Resolve table
        const entry = entries.read(entryId, scratch)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Skip pinned and overflow entries
        if ((entryFlags & (NodeFlags.PINNED | NodeFlags.OVERFLOW)) != 0) {
            continue;
        }
        // Update level stack
        state.currentLevelStack.select(level, entryId);
        const isFirstEntry = state.currentLevelStack.isFirst[level];
        // Add row gap when first
        const settings = state.levelSettings[level];
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // Render child columns
        renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), out);
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
        // Output column node
        const tableName = snapshot.readName(entry.nameId());
        const tableKey = state.currentLevelStack.getKey(level);
        return (
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
                    left: state.levelOffsetsX[level],
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
function renderPinnedEntries(state: CatalogRenderingState, snapshot: CatalogSnapshotReader, level: number, pinnedEntries: PinnedCatalogEntry[], out: React.ReactElement[]) {
    const entries = state.levelBuffers[level];
    const scratch = state.levelScratchBuffers[level];
    const flags = state.levelNodeFlags[level];

    for (const pinnedEntry of pinnedEntries) {
        // Resolve table
        const entryId = pinnedEntry.entryId;
        const entry = entries.read(pinnedEntry.entryId, scratch)!;
        const entryFlags = readNodeFlags(flags, entryId);
        // Update level stack
        state.currentLevelStack.select(level, entryId);
        const isFirstEntry = state.currentLevelStack.isFirst[level];
        // Add row gap when first
        const settings = state.levelSettings[level];
        state.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
        // Remember own position
        let thisPosY = state.currentWriterY;
        // First render all pinned children
        renderPinnedEntries(state, snapshot, level + 1, pinnedEntry.pinnedChildren, out);
        // Then render all unpinned entries
        renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), out);
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
        // Output column node
        const tableName = snapshot.readName(entry.nameId());
        const tableKey = state.currentLevelStack.getKey(level);
        return (
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
                    left: state.levelOffsetsX[level],
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
    layoutEntries(state, snapshot, 0, 0, state.levelBuffers[0].length());
}

/// A function to render a catalog
export function renderCatalog(state: CatalogRenderingState, catalog: CatalogSnapshot): React.ReactElement[] {
    const snapshot = catalog.read();
    const out: React.ReactElement[] = [];

    // First, render the pinned databases
    renderPinnedEntries(state, snapshot, 0, state.pinnedDatabases, out);
    // Then render the unpinned databases
    renderUnpinnedEntries(state, snapshot, 0, 0, state.levelBuffers[0].length(), out);
    return out;
}
