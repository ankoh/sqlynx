import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_renderer.module.css';

import { classNames } from '../../utils/classnames.js';
import { buildEdgePath, selectHorizontalEdgeType } from './graph_edges.js';
import { CatalogRenderingState, NodeRenderingFlag, PinnedCatalogEntry, readNodeFlags } from './catalog_view_model.js';

/// Render unpinned entries and emit ReactElements if they are within the virtual scroll window
function renderUnpinnedEntries(state: CatalogRenderingState, snapshot: sqlynx.SQLynxCatalogSnapshotReader, level: number, entriesBegin: number, entriesCount: number, outNodes: React.ReactElement[], outEdges: React.ReactElement[]) {
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
        if ((entryFlags & NodeRenderingFlag.PINNED) != 0) {
            continue;
        }
        // Skip overflow entries
        if ((entryFlags & NodeRenderingFlag.OVERFLOW) != 0) {
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
            renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes, outEdges);
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
        const thisKey = state.currentRenderingPath.getKey(level);
        const thisName = snapshot.readName(entry.nameId());
        outNodes.push(
            <div
                key={thisKey}

                className={classNames(styles.node_default, {
                    [styles.node_focus_script]: (entryFlags & NodeRenderingFlag.PINNED_BY_SCRIPT_REFS) != 0,
                    [styles.node_focus_catalog]: (entryFlags & NodeRenderingFlag.PINNED_BY_SCRIPT_CURSOR) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeRenderingFlag.PRIMARY_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeRenderingFlag.PINNED) != 0,
                })}
                style={{
                    position: 'absolute',
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                data-snapshot-entry={thisKey}
                data-snapshot-level={level.toString()}
                data-catalog-object={entry.catalogObjectId()}
            >
                {thisName}
            </div>
        );
        // Output edge
        if (entry.childCount() > 0) {
            const fromX = positionX + settings.nodeWidth / 2;
            const fromY = thisPosY + settings.nodeHeight / 2;
            const toSettings = state.levels[level + 1].settings;
            const toPositionsY = state.levels[level + 1].scratchPositionsY;
            const toX = state.levels[level + 1].positionX + toSettings.nodeWidth / 2;

            for (let i = 0; i < entry.childCount(); ++i) {
                const entryId = entry.childBegin() + i;
                const toY = toPositionsY[entryId] + toSettings.nodeHeight / 2;
                const edgeType = selectHorizontalEdgeType(fromX, fromY, toX, toY);
                const edgePath = buildEdgePath(state.edgeBuilder, edgeType, fromX, fromY, toX, toY, settings.nodeWidth, settings.nodeHeight, toSettings.nodeWidth, toSettings.nodeHeight, 10, 10, 4);
                const edgeKey = `${thisKey}:${i}`;
                outEdges.push(
                    <path
                        key={edgeKey}

                        d={edgePath}
                        strokeWidth="2px"
                        stroke="currentcolor"
                        fill="transparent"
                        pointerEvents="stroke"
                        data-edge={edgeKey}
                    />,

                );
            }
        }
    }

    // Render overflow entry
    if (overflowChildCount > 0) {
        state.currentWriterY += settings.rowGap;
        const thisPosY = state.currentWriterY;
        state.currentWriterY += settings.nodeHeight;

        if (state.currentWriterY > state.currentRenderingWindow.virtualScrollWindowBegin && thisPosY < state.currentRenderingWindow.virtualScrollWindowEnd) {
            state.currentRenderingWindow.addNode(thisPosY, settings.nodeHeight);
            scratchPositions[lastOverflowEntryId] = thisPosY;
            const key = state.currentRenderingPath.getKeyPrefix(level);
            const overflowKey = `${key}:overflow`;
            outNodes.push(
                <div
                    key={overflowKey}

                    className={classNames(styles.node_default, styles.node_overflow)}
                    style={{
                        position: 'absolute',
                        top: thisPosY,
                        left: positionX,
                        width: settings.nodeWidth,
                        height: settings.nodeHeight,
                    }}
                    data-snapshot-entry={key}
                    data-snapshot-level={level.toString()}
                >
                    {overflowChildCount}
                </div>
            );
        }
    }
}

/// A function to render entries
function renderPinnedEntries(state: CatalogRenderingState, snapshot: sqlynx.SQLynxCatalogSnapshotReader, level: number, pinnedEntries: PinnedCatalogEntry[], outNodes: React.ReactElement[], outEdges: React.ReactElement[]) {
    const settings = state.levels[level].settings;
    const entries = state.levels[level].entries;
    const scratchEntry = state.levels[level].scratchEntry;
    const scratchPositions = state.levels[level].scratchPositionsY;
    const flags = state.levels[level].flags;
    const positionX = state.levels[level].positionX;

    for (const pinnedEntry of pinnedEntries) {
        // Resolve table
        const entryId = pinnedEntry.catalogEntryId;
        const entry = entries.read(snapshot, pinnedEntry.catalogEntryId, scratchEntry)!;
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
        if (pinnedEntry.pinnedChildren.size > 0) {
            renderPinnedEntries(state, snapshot, level + 1, pinnedEntry.pinnedChildren, outNodes, outEdges);
        }
        // Then render all unpinned entries
        if (entry.childCount() > 0) {
            renderUnpinnedEntries(state, snapshot, level + 1, entry.childBegin(), entry.childCount(), outNodes, outEdges);
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
        const thisKey = state.currentRenderingPath.getKey(level);
        const thisName = snapshot.readName(entry.nameId());
        outNodes.push(
            <div
                key={thisKey}

                className={classNames(styles.node_default, {
                    [styles.node_focus_script_refs]: (entryFlags & NodeRenderingFlag.PINNED_BY_SCRIPT_REFS) != 0,
                    [styles.node_focus_script_cursor]: (entryFlags & NodeRenderingFlag.PINNED_BY_SCRIPT_CURSOR) != 0,
                    [styles.node_focus_direct]: (entryFlags & NodeRenderingFlag.PRIMARY_FOCUS) != 0,
                    [styles.node_pinned]: (entryFlags & NodeRenderingFlag.PINNED) != 0,
                })}
                style={{
                    position: 'absolute',
                    top: thisPosY,
                    left: positionX,
                    width: settings.nodeWidth,
                    height: settings.nodeHeight,
                }}
                data-snapshot-entry={thisKey}
                data-snapshot-level={level.toString()}
            >
                {thisName}
            </div>
        );
    }
}

/// A function to render a catalog
export function renderCatalog(state: CatalogRenderingState, outNodes: React.ReactElement[], outEdges: React.ReactElement[]) {
    const snap = state.snapshot.read();

    // Reset the rendering
    state.resetWriter();
    // First, render the pinned databases
    renderPinnedEntries(state, snap, 0, state.pinnedDatabases, outNodes, outEdges);
    // Then render the unpinned databases
    renderUnpinnedEntries(state, snap, 0, 0, state.levels[0].entries.length(snap), outNodes, outEdges);
    return outNodes;
}
