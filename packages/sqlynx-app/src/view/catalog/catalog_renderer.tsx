import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_renderer.module.css';

import { EdgePathBuilder } from './graph_edges.js';
import { classNames } from '../../utils/classnames.js';
import { buildEdgePath, selectHorizontalEdgeType } from './graph_edges.js';
import { CatalogViewModel, CatalogRenderingFlag, PINNED_BY_ANYTHING } from './catalog_view_model.js';

/// A rendering path.
/// A cheap way to track the path of parent ids when rendering the catalog.
class RenderingPath {
    /// The entries ids
    public entryIds: Uint32Array;

    constructor() {
        this.entryIds = new Uint32Array(4);
    }
    public reset() {
        this.entryIds[0] = 0xFFFFFFFF;
        this.entryIds[1] = 0xFFFFFFFF;
        this.entryIds[2] = 0xFFFFFFFF;
        this.entryIds[4] = 0xFFFFFFFF;
    }
    public truncate(level: number) {
        for (let i = level + 1; i < 4; ++i) {
            this.entryIds[i] = 0xFFFFFFFF;
        }
    }
    public select(level: number, id: number) {
        this.entryIds[level] = id;
    }
    public getKeyPrefix(level: number) {
        if (level == 0) {
            return '';
        } else {
            let out = this.entryIds[0]!.toString();
            for (let i = 1; i < level; ++i) {
                out += '/';
                out += this.entryIds[i]!.toString();
            }
            return out;
        }
    }
    public getKey(level: number) {
        let out = this.entryIds[0]!.toString();
        for (let i = 1; i < (level + 1); ++i) {
            out += '/';
            out += this.entryIds[i]!.toString();
        }
        return out;
    }
}

class VirtualRenderingWindowStats {
    /// Minimum position in the scroll window
    minInScrollWindow: number;
    /// Maximum position in the scroll window
    maxInScrollWindow: number;

    constructor(tracker: VirtualRenderingWindow) {
        this.minInScrollWindow = tracker.scrollWindowEnd;
        this.maxInScrollWindow = tracker.scrollWindowBegin;
    }
    reset(tracker: VirtualRenderingWindow) {
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

class VirtualRenderingWindow {
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
    statistics: VirtualRenderingWindowStats[]

    constructor(begin: number, end: number, virtualBegin: number, virtualEnd: number) {
        this.scrollWindowBegin = begin;
        this.scrollWindowEnd = end;
        this.virtualScrollWindowBegin = virtualBegin;
        this.virtualScrollWindowEnd = virtualEnd;
        this.statisticsCount = 1;
        this.statistics = [
            new VirtualRenderingWindowStats(this),
            new VirtualRenderingWindowStats(this),
            new VirtualRenderingWindowStats(this),
            new VirtualRenderingWindowStats(this),
            new VirtualRenderingWindowStats(this),
        ];
    }
    startRenderingChildren() {
        this.statistics[this.statisticsCount].reset(this);
        ++this.statisticsCount;
    }
    stopRenderingChildren(): VirtualRenderingWindowStats {
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

interface RenderingContext {
    /// The viewModel
    viewModel: CatalogViewModel;
    /// The snapshot
    snapshot: sqlynx.SQLynxCatalogSnapshotReader;
    /// The rendering epoch
    renderingEpoch: number;
    /// The current writer
    currentWriterY: number;
    /// The rendering path
    renderingPath: RenderingPath;
    /// The virtual rendering window
    renderingWindow: VirtualRenderingWindow;
    /// The edge builder
    edgeBuilder: EdgePathBuilder;
    /// The output nodes
    outNodes: React.ReactElement[];
    /// The output edges
    outEdges: React.ReactElement[];
};

/// Render entries and emit ReactElements if they are within the virtual scroll window
function renderEntriesAtLevel(ctx: RenderingContext, levelId: number, entriesBegin: number, entriesCount: number) {
    const level = ctx.viewModel.levels[levelId];
    const settings = level.settings;
    const entries = level.entries;
    const scratchEntry = level.scratchEntry;
    const flags = level.entryFlags;
    const positionX = level.positionX;
    const positionsY = level.positionsY;
    const renderingEpochs = level.renderedInEpoch;

    // Track overflow nodes
    let overflowChildCount = 0;
    let lastOverflowEntryId = 0;
    let isFirst = false;

    // First render all pinned entries, then all unpinned
    for (const renderPinned of [true, false]) {
        overflowChildCount = 0;
        for (let i = 0; i < entriesCount; ++i) {
            // Resolve table
            const entryId = entriesBegin + i;
            const entryFlags = flags[entryId];
            const isPinnedByAnything = (entryFlags & PINNED_BY_ANYTHING) != 0;
            // Quickly skip over irrelevant entries
            if (isPinnedByAnything != renderPinned) {
                continue;
            }
            // Skip overflow entries
            if ((entryFlags & CatalogRenderingFlag.OVERFLOW) != 0) {
                ++overflowChildCount;
                lastOverflowEntryId = entryId;
                continue;
            }
            // Update rendering path
            ctx.renderingPath.select(levelId, entryId);
            // Add row gap when first
            ctx.currentWriterY += isFirst ? 0 : settings.rowGap;
            isFirst = false;
            // Remember own position
            let thisPosY = ctx.currentWriterY;
            // Render children
            let centerInScrollWindow: number | null = null;
            const entry = entries.read(ctx.snapshot, entryId, scratchEntry)!;
            if (entry.childCount() > 0) {
                ctx.renderingWindow.startRenderingChildren();
                renderEntriesAtLevel(ctx, levelId + 1, entry.childBegin(), entry.childCount());
                const stats = ctx.renderingWindow.stopRenderingChildren();
                centerInScrollWindow = stats.centerInScrollWindow();
            }
            // Bump writer if the columns didn't already
            ctx.currentWriterY = Math.max(ctx.currentWriterY, thisPosY + settings.nodeHeight);
            // Truncate any stack items that children added
            ctx.renderingPath.truncate(levelId);
            // Vertically center the node over all child nodes
            thisPosY = centerInScrollWindow == null ? thisPosY : (centerInScrollWindow - settings.nodeHeight / 2);
            // Break if lower bound is larger than virtual window
            if (thisPosY >= ctx.renderingWindow.virtualScrollWindowEnd) {
                break;
            }
            // Skip if upper bound is smaller than virtual window
            if (ctx.currentWriterY < ctx.renderingWindow.virtualScrollWindowBegin) {
                continue;
            }
            // Remember the node position
            ctx.renderingWindow.addNode(thisPosY, settings.nodeHeight);
            positionsY[entryId] = thisPosY;
            renderingEpochs[entryId] = ctx.renderingEpoch;
            // Output node
            const thisKey = ctx.renderingPath.getKey(levelId);
            const thisName = ctx.snapshot.readName(entry.nameId());
            ctx.outNodes.push(
                <div
                    key={thisKey}
                    className={classNames(styles.node_default, {
                        [styles.node_focus_script_table_refs]: (entryFlags & CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS) != 0,
                        [styles.node_focus_script_column_refs]: (entryFlags & CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS) != 0,
                        [styles.node_focus_script_cursor]: (entryFlags & CatalogRenderingFlag.PINNED_BY_SCRIPT_CURSOR) != 0,
                        [styles.node_focus_direct]: (entryFlags & CatalogRenderingFlag.PRIMARY_FOCUS) != 0,
                        [styles.node_pinned]: (entryFlags & PINNED_BY_ANYTHING) != 0,
                    })}
                    style={{
                        position: 'absolute',
                        top: thisPosY,
                        left: positionX,
                        width: settings.nodeWidth,
                        height: settings.nodeHeight,
                    }}
                    data-snapshot-entry={thisKey}
                    data-snapshot-level={levelId.toString()}
                    data-catalog-object={entry.catalogObjectId()}
                >
                    {thisName}
                </div>
            );
            // Draw edges to all children
            if (entry.childCount() > 0) {
                const fromX = positionX + settings.nodeWidth / 2;
                const fromY = thisPosY + settings.nodeHeight / 2;
                const toSettings = ctx.viewModel.levels[levelId + 1].settings;
                const toPositionsY = ctx.viewModel.levels[levelId + 1].positionsY;
                const toX = ctx.viewModel.levels[levelId + 1].positionX + toSettings.nodeWidth / 2;
                const toEpochs = ctx.viewModel.levels[levelId + 1].renderedInEpoch;

                for (let i = 0; i < entry.childCount(); ++i) {
                    const entryId = entry.childBegin() + i;
                    // Don't draw an edge to nodes that were not rendered this epoch
                    if (toEpochs[entryId] != ctx.renderingEpoch) {
                        continue;;
                    }
                    const toY = toPositionsY[entryId] + toSettings.nodeHeight / 2;
                    const edgeType = selectHorizontalEdgeType(fromX, fromY, toX, toY);
                    const edgePath = buildEdgePath(ctx.edgeBuilder, edgeType, fromX, fromY, toX, toY, settings.nodeWidth, settings.nodeHeight, toSettings.nodeWidth, toSettings.nodeHeight, 10, 10, 4);
                    const edgeKey = `${thisKey}:${i}`;
                    ctx.outEdges.push(
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
    }

    // Render overflow entry
    if (overflowChildCount > 0) {
        ctx.currentWriterY += settings.rowGap;
        const thisPosY = ctx.currentWriterY;
        ctx.currentWriterY += settings.nodeHeight;

        if (ctx.currentWriterY > ctx.renderingWindow.virtualScrollWindowBegin && thisPosY < ctx.renderingWindow.virtualScrollWindowEnd) {
            ctx.renderingWindow.addNode(thisPosY, settings.nodeHeight);
            positionsY[lastOverflowEntryId] = thisPosY;
            renderingEpochs[lastOverflowEntryId] = ctx.renderingEpoch;
            const key = ctx.renderingPath.getKeyPrefix(levelId);
            const overflowKey = `${key}:overflow`;
            ctx.outNodes.push(
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
                    data-snapshot-level={levelId.toString()}
                >
                    {overflowChildCount}
                </div>
            );
        }
    }
}

/// A function to render a catalog
export function renderCatalog(viewModel: CatalogViewModel, outNodes: React.ReactElement[], outEdges: React.ReactElement[]) {
    const ctx: RenderingContext = {
        viewModel,
        snapshot: viewModel.snapshot.read(),
        renderingEpoch: viewModel.nextRenderingEpoch++,
        currentWriterY: 0,
        renderingPath: new RenderingPath(),
        renderingWindow: new VirtualRenderingWindow(viewModel.scrollBegin, viewModel.scrollEnd, viewModel.virtualScrollBegin, viewModel.virtualScrollEnd),
        edgeBuilder: new EdgePathBuilder(),
        outNodes,
        outEdges,
    };
    renderEntriesAtLevel(ctx, 0, 0, viewModel.databaseEntries.entries.length(ctx.snapshot));
    return outNodes;
}
