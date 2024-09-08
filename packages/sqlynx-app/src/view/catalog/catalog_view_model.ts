import * as sqlynx from '@ankoh/sqlynx-core';
import { U32_MAX } from '../../utils/numeric_limits.js';

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

/// The flags for rendering catalog entries
export enum CatalogRenderingFlag {
    DEFAULT = 0,
    OVERFLOW = 0b1,
    PINNED_BY_SCRIPT_TABLE_REFS = 0b10,
    PINNED_BY_SCRIPT_COLUMN_REFS = 0b100,
    PINNED_BY_SCRIPT_CURSOR = 0b1000,
    PRIMARY_FOCUS = 0b10000,
}

/// Pinned by anything
export const PINNED_BY_ANYTHING =
    CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS |
    CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS |
    CatalogRenderingFlag.PINNED_BY_SCRIPT_CURSOR;


/// A span of catalog entries
interface CatalogEntrySpan {
    read(snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry): sqlynx.proto.FlatCatalogEntry | null;
    length(snap: sqlynx.SQLynxCatalogSnapshotReader): number;
}

class PendingLayoutUpdates {
    root: boolean;
    databases: Set<number>;
    schemas: Set<number>;
    tables: Set<number>;
    columns: Set<number>;

    constructor() {
        this.root = false;
        this.databases = new Set();
        this.schemas = new Set();
        this.tables = new Set();
        this.columns = new Set();
    }
}

interface LayoutContext {
    /// The snapshot
    snapshot: sqlynx.SQLynxCatalogSnapshotReader;
    /// The current writer
    currentWriterY: number;
};

interface CatalogLevelViewModel {
    /// The rendering settings
    settings: CatalogLevelRenderingSettings;
    /// The buffers
    entries: CatalogEntrySpan;
    /// The rendering flags
    entryFlags: Uint8Array;
    /// The subtree heights
    subtreeHeights: Float32Array;
    /// The x offset
    positionX: number;
    /// The y positions as written during rendering (if visible)
    positionsY: Float32Array;
    /// The epochs in which this node was rendered
    renderedInEpoch: Uint32Array;
    /// The pinned entries
    pinnedEntries: Set<number>;
    /// The epochs in which this node was pinned
    pinnedInEpoch: Uint32Array;
    /// The scratch catalog entry
    scratchEntry: sqlynx.proto.FlatCatalogEntry;
}

/// A catalog rendering state
export class CatalogViewModel {
    /// The snapshot.
    /// We have to recreate the state for every new snapshot.
    snapshot: sqlynx.SQLynxCatalogSnapshot;
    /// The rendering settings
    settings: CatalogRenderingSettings;

    /// The database entries
    databaseEntries: CatalogLevelViewModel;
    /// The schema entries
    schemaEntries: CatalogLevelViewModel;
    /// The table entries
    tableEntries: CatalogLevelViewModel;
    /// The column entries
    columnEntries: CatalogLevelViewModel;

    /// The next rendering epoch
    nextRenderingEpoch: number;
    /// The pin epoch counter
    nextPinEpoch: number;

    /// The total height of all nodes
    totalHeight: number;
    /// The total width of all nodes
    totalWidth: number;

    /// The pending layout updates
    pendingLayoutUpdates: PendingLayoutUpdates;

    /// The begin of the scroll window
    scrollBegin: number;
    /// The end of the scroll window
    scrollEnd: number;
    /// The begin of the virtual scroll window
    virtualScrollBegin: number;
    /// The end of the virtual scroll window
    virtualScrollEnd: number;

    /// A temporary database object
    tmpDatabaseEntry: sqlynx.proto.IndexedFlatDatabaseEntry;
    /// A temporary schema object
    tmpSchemaEntry: sqlynx.proto.IndexedFlatSchemaEntry;
    /// A temporary table object
    tmpTableEntry: sqlynx.proto.IndexedFlatTableEntry;

    constructor(snapshot: sqlynx.SQLynxCatalogSnapshot, settings: CatalogRenderingSettings) {
        this.snapshot = snapshot;
        this.settings = settings;
        this.nextRenderingEpoch = 100;
        this.nextPinEpoch = 1;
        const snap = snapshot.read();
        this.databaseEntries = {
            settings: settings.levels.databases,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.databases(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.databasesLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.databasesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.databasesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.databasesLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.databasesLength()),
            pinnedEntries: new Set(),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.databasesLength()),
        };
        this.schemaEntries = {
            settings: settings.levels.schemas,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.schemas(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.schemasLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.schemasLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.schemasLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.schemasLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.schemasLength()),
            pinnedEntries: new Set(),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.schemasLength()),
        };
        this.tableEntries = {
            settings: settings.levels.tables,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.tables(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.tablesLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.tablesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.tablesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.tablesLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.tablesLength()),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.tablesLength()),
            pinnedEntries: new Set(),
        };
        this.columnEntries = {
            settings: settings.levels.columns,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.columns(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.columnsLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.columnsLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.columnsLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.columnsLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.columnsLength()),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.columnsLength()),
            pinnedEntries: new Set(),
        };
        this.schemaEntries.positionX = settings.levels.databases.nodeWidth + settings.levels.databases.columnGap;
        this.tableEntries.positionX = this.schemaEntries.positionX + settings.levels.schemas.nodeWidth + settings.levels.schemas.columnGap;
        this.columnEntries.positionX = this.tableEntries.positionX + settings.levels.tables.nodeWidth + settings.levels.tables.columnGap;

        this.totalWidth = 0;
        this.totalHeight = 0;
        this.pendingLayoutUpdates = new PendingLayoutUpdates();

        this.scrollBegin = 0;
        this.scrollEnd = 200;
        this.virtualScrollBegin = 0;
        this.virtualScrollEnd = 300;

        this.tmpDatabaseEntry = new sqlynx.proto.IndexedFlatDatabaseEntry();
        this.tmpSchemaEntry = new sqlynx.proto.IndexedFlatSchemaEntry();
        this.tmpTableEntry = new sqlynx.proto.IndexedFlatTableEntry();

        // Layout all entries.
        // This means users don't have to special-case the states without layout.
        this.layoutEntries();
    }

    get levels() {
        return [this.databaseEntries, this.schemaEntries, this.tableEntries, this.columnEntries];
    }

    /// Update the scroll window
    updateWindow(begin: number, end: number, virtualBegin: number, virtualEnd: number) {
        this.scrollBegin = begin;
        this.scrollEnd = end;
        this.virtualScrollBegin = virtualBegin;
        this.virtualScrollEnd = virtualEnd;
    }

    /// Layout entries at a level
    static layoutEntriesAtLevel(ctx: LayoutContext, levels: CatalogLevelViewModel[], levelId: number, entriesBegin: number, entriesCount: number) {
        const level = levels[levelId];
        let unpinnedChildCount = 0;
        let overflowChildCount = 0;
        let isFirstEntry = true;

        // Don't overflow children if we have maxUnPinnedChildren + 1 children.
        // Adding the overflow node to reference a single overflow does not make sense.
        const skipOverflow = entriesCount <= (level.settings.maxUnpinnedChildren + 1);

        for (let i = 0; i < entriesCount; ++i) {
            const entryId = entriesBegin + i;
            const entry = level.entries.read(ctx.snapshot, entryId, level.scratchEntry)!;
            const entryFlags = level.entryFlags[entryId];

            // Pinned and unpinned entries have the same height, so it doesn't matter that we're accounting for them here in the "wrong" order.

            // Skip the node if the node is UNPINNED and the child count hit the limit
            if ((entryFlags & PINNED_BY_ANYTHING) == 0) {
                ++unpinnedChildCount;
                if (unpinnedChildCount > level.settings.maxUnpinnedChildren && !skipOverflow) {
                    ++overflowChildCount;
                    level.entryFlags[entryId] |= CatalogRenderingFlag.OVERFLOW;
                    continue;
                }
            }
            // Clear any previous overflow flags
            level.entryFlags[entryId] &= ~CatalogRenderingFlag.OVERFLOW;

            // Add row gap when first
            // We could also account for that in the end
            ctx.currentWriterY += isFirstEntry ? 0 : level.settings.rowGap;
            isFirstEntry = false;
            // Remember own position
            let thisPosY = ctx.currentWriterY;
            // Render child columns
            if (entry.childCount() > 0) {
                this.layoutEntriesAtLevel(ctx, levels, levelId + 1, entry.childBegin(), entry.childCount());
            }
            // Bump writer if the columns didn't already
            ctx.currentWriterY = Math.max(ctx.currentWriterY, thisPosY + level.settings.nodeHeight);
            // Store the subtree height
            // Note that we deliberately do not include the entries row gap here.
            // If we would, we couldn't update this easily from the children.
            // (We would have to know if our parent is the child)
            level.subtreeHeights[entryId] = ctx.currentWriterY - thisPosY;
        }

        // Add space for the overflow node
        if (overflowChildCount > 0) {
            ctx.currentWriterY += level.settings.rowGap;
            ctx.currentWriterY += level.settings.nodeHeight;
        }
    }

    /// Layout all entries
    layoutEntries() {
        const snap = this.snapshot.read();
        const databaseCount = this.databaseEntries.entries.length(snap);
        const ctx: LayoutContext = {
            snapshot: snap,
            currentWriterY: 0,
        };
        CatalogViewModel.layoutEntriesAtLevel(ctx, this.levels, 0, 0, databaseCount);
        this.totalHeight = ctx.currentWriterY;
        this.totalWidth = this.columnEntries.positionX + this.settings.levels.columns.nodeWidth + this.settings.levels.columns.columnGap;
    }

    /// Flush all pending layout updates
    layoutPendingEntries() {
        // XXX Shortcut
        this.layoutEntries();
    }

    /// Pin an element
    pin(catalog: sqlynx.proto.FlatCatalog,
        epoch: number,
        flags: number,
        dbId: number,
        schemaId: number | null,
        tableId: bigint | null,
        columnId: number | null,
    ) {
        // Remember catalog entry ids
        let dbEntryId: number | null = null;
        let schemaEntryId: number | null = null;
        let tableEntryId: number | null = null;
        let columnEntryId: number | null = null;

        // Remember previous entry flags
        let prevDbFlags: number | null = null;
        let prevSchemaFlags: number | null = null;
        let prevTableFlags: number | null = null;
        let prevColumnFlags: number | null = null;

        // Lookup the database id in the catalog
        dbEntryId = sqlynx.findCatalogDatabaseById(catalog, dbId, this.tmpDatabaseEntry);
        if (dbEntryId == null) {
            // Failed to locate database in the catalog?
            // Return early, this won't work.
            return;
        }

        // Mark the database pinned
        prevDbFlags = this.databaseEntries.entryFlags[dbEntryId];
        this.databaseEntries.entryFlags[dbEntryId] |= flags;
        this.databaseEntries.pinnedInEpoch[dbEntryId] = epoch;
        this.databaseEntries.pinnedEntries.add(dbEntryId);

        // Lookup the schema id in the catalog
        if (schemaId != null) {
            schemaEntryId = sqlynx.findCatalogSchemaById(catalog, schemaId, this.tmpSchemaEntry);
            if (schemaEntryId != null) {
                prevSchemaFlags = this.schemaEntries.entryFlags[schemaEntryId];
                this.schemaEntries.entryFlags[schemaEntryId] |= flags;
                this.schemaEntries.pinnedInEpoch[schemaEntryId] = epoch;
                this.schemaEntries.pinnedEntries.add(schemaEntryId);

                // Lookup the table id in the catalog
                if (tableId != null) {
                    tableEntryId = sqlynx.findCatalogTableById(catalog, tableId, this.tmpTableEntry);
                    if (tableEntryId != null) {
                        prevTableFlags = this.tableEntries.entryFlags[tableEntryId];
                        this.tableEntries.entryFlags[tableEntryId] |= flags;
                        this.tableEntries.pinnedInEpoch[tableEntryId] = epoch;
                        this.tableEntries.pinnedEntries.add(tableEntryId);

                        // Lookup the column in the catalog
                        if (columnId != null) {
                            const tableProto = catalog.tables(tableEntryId)!;
                            const tableChildrenBegin = tableProto.childBegin();
                            columnEntryId = tableChildrenBegin + columnId;
                            prevColumnFlags = this.columnEntries.entryFlags[columnEntryId];
                            this.columnEntries.entryFlags[columnEntryId] |= flags;
                            this.columnEntries.pinnedInEpoch[columnEntryId] = epoch;
                            this.columnEntries.pinnedEntries.add(columnEntryId);
                        }
                    }
                }
            }
        }

        // Figure out the parent of the first overflowing node
        if ((prevDbFlags & CatalogRenderingFlag.OVERFLOW) != 0) {
            this.pendingLayoutUpdates.root = true;
        } else if (prevSchemaFlags != null && (prevSchemaFlags & CatalogRenderingFlag.OVERFLOW) != 0) {
            this.pendingLayoutUpdates.databases.add(dbEntryId);
        } else if (prevTableFlags != null && (prevTableFlags & CatalogRenderingFlag.OVERFLOW) != 0) {
            this.pendingLayoutUpdates.schemas.add(schemaEntryId!);
        } else if (prevColumnFlags != null && (prevColumnFlags & CatalogRenderingFlag.OVERFLOW) != 0) {
            this.pendingLayoutUpdates.tables.add(tableEntryId!);
        }
    }

    // Unpin old entries.
    unpin(pinFlags: number, currentEpoch: number) {
        const snap = this.snapshot.read();

        // Find databases that are no longer pinned
        for (const catalogEntryId of this.databaseEntries.pinnedEntries) {
            // Only check entries pinned with certain flags
            let entryFlags = this.databaseEntries.entryFlags[catalogEntryId];
            if ((entryFlags & pinFlags) != 0) {
                // It was not pinned in this epoch?
                let pinnedInEpoch = this.databaseEntries.pinnedInEpoch[catalogEntryId];
                if (pinnedInEpoch != currentEpoch) {
                    // Then we clear the pin flags and check the database is no longer pinned
                    entryFlags &= ~pinFlags;
                    this.databaseEntries.entryFlags[catalogEntryId] = entryFlags;
                    // Is the entry no longer pinned?
                    // For databases that means that we have to layout everything.
                    if ((entryFlags & PINNED_BY_ANYTHING) == 0) {
                        this.databaseEntries.pinnedEntries.delete(catalogEntryId);
                        // Mark the root for updates
                        this.pendingLayoutUpdates.root = true;
                    }
                }
            }
        }

        // Check all other levels
        const levels: [CatalogLevelViewModel, Set<number>][] = [
            [this.schemaEntries, this.pendingLayoutUpdates.databases],
            [this.tableEntries, this.pendingLayoutUpdates.schemas],
            [this.columnEntries, this.pendingLayoutUpdates.tables],
        ];
        for (const [level, layoutUpdates] of levels) {
            // Find entries that are no longer pinned
            for (const catalogEntryId of level.pinnedEntries) {
                // Only check entries pinned with certain flags
                let entryFlags = level.entryFlags[catalogEntryId];
                if ((entryFlags & pinFlags) != 0) {
                    // It was not pinned in this epoch?
                    let pinnedInEpoch = level.pinnedInEpoch[catalogEntryId];
                    if (pinnedInEpoch != currentEpoch) {
                        // Then we clear the pin flags and check the database is no longer pinned
                        entryFlags &= ~pinFlags;
                        level.entryFlags[catalogEntryId] = entryFlags;
                        // Is the entry no longer pinned?
                        if ((entryFlags & PINNED_BY_ANYTHING) == 0) {
                            level.pinnedEntries.delete(catalogEntryId);
                            // Mark the parent for updates
                            const entry = level.entries.read(snap, catalogEntryId, level.scratchEntry)!;
                            const parentCatalogEntryId = entry!.flatParentIdx();
                            layoutUpdates.add(parentCatalogEntryId);
                        }
                    }
                }
            }
        }
    }


    // Pin all script refs
    pinScriptRefs(script: sqlynx.proto.AnalyzedScript) {
        const catalog = this.snapshot.read().catalogReader;
        const tmpTableRef = new sqlynx.proto.TableReference();
        const tmpExpression = new sqlynx.proto.Expression();
        const tmpResolvedColumnRef = new sqlynx.proto.ResolvedColumnRefExpression();
        const tmpResolvedRelationExpr = new sqlynx.proto.ResolvedRelationExpression();

        // Allocate an epoch
        const epoch = this.nextPinEpoch++;

        // Pin table references
        for (let i = 0; i < script.tableReferencesLength(); ++i) {
            const tableRef = script.tableReferences(i, tmpTableRef)!;
            if (tableRef.innerType() == sqlynx.proto.TableReferenceSubType.ResolvedRelationExpression) {
                const resolved = tableRef.inner(tmpResolvedRelationExpr) as sqlynx.proto.ResolvedRelationExpression;
                const dbId = resolved.catalogDatabaseId();
                const schemaId = resolved.catalogSchemaId();
                const tableId = resolved.catalogTableId();
                this.pin(catalog, epoch, CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS, dbId, schemaId, tableId, null);
            }
        }

        // Pin resolved column references
        for (let i = 0; i < script.expressionsLength(); ++i) {
            const expr = script.expressions(i, tmpExpression)!;
            if (expr.innerType() == sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression) {
                const columnRef = expr.inner(tmpResolvedColumnRef) as sqlynx.proto.ResolvedColumnRefExpression;
                const dbId = columnRef.catalogDatabaseId();
                const schemaId = columnRef.catalogSchemaId();
                const tableId = columnRef.catalogTableId();
                const columnId = columnRef.columnId();
                this.pin(catalog, epoch, CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS, dbId, schemaId, tableId, columnId);
            }
        }

        // Unpin all entries were pinned with the same flags in a previous epoch
        this.unpin(CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS | CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS, epoch);

        // Now run all necessary layout updates
        this.layoutPendingEntries();
    }


    pinCursorRefs(_cursor: sqlynx.proto.ScriptCursor) {
        // Allocate an epoch
        const epoch = this.nextPinEpoch++;

        // Unpin all cursor refs that were pinned in a previous epoch
        this.unpin(CatalogRenderingFlag.PINNED_BY_SCRIPT_CURSOR, epoch);
    }
}
