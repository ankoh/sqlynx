import * as sqlynx from '@ankoh/sqlynx-core';
import { FocusType, UserFocus } from '../../session/focus.js';
import { QUALIFIED_DATABASE_ID, QUALIFIED_SCHEMA_ID, QUALIFIED_TABLE_COLUMN_ID, QUALIFIED_TABLE_ID, QualifiedCatalogObjectID } from '../../session/catalog_object_id.js';

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

    SCRIPT_TABLE_REF = 0b1 << 1,
    SCRIPT_TABLE_REF_PATH = 0b1 << 2,
    SCRIPT_COLUMN_REF = 0b1 << 3,
    SCRIPT_COLUMN_REF_PATH = 0b1 << 4,

    FOCUS_TABLE_REF = 0b1 << 5,
    FOCUS_TABLE_REF_PATH = 0b1 << 6,
    FOCUS_COLUMN_REF = 0b1 << 7,
    FOCUS_COLUMN_REF_PATH = 0b1 << 8,
    FOCUS_COMPLETION_CANDIDATE = 0b1 << 9,
    FOCUS_COMPLETION_CANDIDATE_PATH = 0b1 << 10,
    FOCUS_CATALOG_ENTRY = 0b1 << 11,
    FOCUS_CATALOG_ENTRY_PATH = 0b1 << 12,
}

export const PINNED_BY_SCRIPT =
    CatalogRenderingFlag.SCRIPT_TABLE_REF |
    CatalogRenderingFlag.SCRIPT_TABLE_REF_PATH |
    CatalogRenderingFlag.SCRIPT_COLUMN_REF |
    CatalogRenderingFlag.SCRIPT_COLUMN_REF_PATH
    ;

export const PINNED_BY_FOCUS_TARGET =
    CatalogRenderingFlag.FOCUS_TABLE_REF |
    CatalogRenderingFlag.FOCUS_COLUMN_REF |
    CatalogRenderingFlag.FOCUS_COMPLETION_CANDIDATE |
    CatalogRenderingFlag.FOCUS_CATALOG_ENTRY
    ;

export const PINNED_BY_FOCUS_PATH =
    CatalogRenderingFlag.FOCUS_TABLE_REF_PATH |
    CatalogRenderingFlag.FOCUS_COLUMN_REF_PATH |
    CatalogRenderingFlag.FOCUS_COMPLETION_CANDIDATE_PATH |
    CatalogRenderingFlag.FOCUS_CATALOG_ENTRY_PATH
    ;

export const PINNED_BY_FOCUS =
    PINNED_BY_FOCUS_TARGET |
    PINNED_BY_FOCUS_PATH
    ;

/// Pinned by anything
export const PINNED_BY_ANYTHING = PINNED_BY_SCRIPT | PINNED_BY_FOCUS;


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
    entryFlags: Uint16Array;
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
    /// The first focused element
    firstFocusedEntry: { epoch: number, entryId: number } | null;
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
            entryFlags: new Uint16Array(snap.catalogReader.databasesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.databasesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.databasesLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.databasesLength()),
            pinnedEntries: new Set(),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.databasesLength()),
            firstFocusedEntry: null,
        };
        this.schemaEntries = {
            settings: settings.levels.schemas,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.schemas(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.schemasLength(),
            },
            entryFlags: new Uint16Array(snap.catalogReader.schemasLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.schemasLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.schemasLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.schemasLength()),
            pinnedEntries: new Set(),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.schemasLength()),
            firstFocusedEntry: null,
        };
        this.tableEntries = {
            settings: settings.levels.tables,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.tables(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.tablesLength(),
            },
            entryFlags: new Uint16Array(snap.catalogReader.tablesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.tablesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.tablesLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.tablesLength()),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.tablesLength()),
            pinnedEntries: new Set(),
            firstFocusedEntry: null,
        };
        this.columnEntries = {
            settings: settings.levels.columns,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.columns(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.columnsLength(),
            },
            entryFlags: new Uint16Array(snap.catalogReader.columnsLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.columnsLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.columnsLength()),
            renderedInEpoch: new Uint32Array(snap.catalogReader.columnsLength()),
            pinnedInEpoch: new Uint32Array(snap.catalogReader.columnsLength()),
            pinnedEntries: new Set(),
            firstFocusedEntry: null,
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
    pinPath(catalog: sqlynx.proto.FlatCatalog,
        epoch: number,
        flagsTarget: number,
        flagsPath: number,
        objectId: QualifiedCatalogObjectID
    ): void {
        // Resolve entry ids
        const entryIds: (number | null)[] = [null, null, null, null];
        switch (objectId.type) {
            case QUALIFIED_DATABASE_ID:
                entryIds[0] = sqlynx.findCatalogDatabaseById(catalog, objectId.value.database, this.tmpDatabaseEntry);
                break;
            case QUALIFIED_SCHEMA_ID:
                entryIds[0] = sqlynx.findCatalogDatabaseById(catalog, objectId.value.database, this.tmpDatabaseEntry);
                entryIds[1] = sqlynx.findCatalogSchemaById(catalog, objectId.value.schema, this.tmpSchemaEntry);
                break;
            case QUALIFIED_TABLE_ID:
                entryIds[0] = sqlynx.findCatalogDatabaseById(catalog, objectId.value.database, this.tmpDatabaseEntry);
                entryIds[1] = sqlynx.findCatalogSchemaById(catalog, objectId.value.schema, this.tmpSchemaEntry);
                entryIds[2] = sqlynx.findCatalogTableById(catalog, objectId.value.table, this.tmpTableEntry);
                break;
            case QUALIFIED_TABLE_COLUMN_ID:
                entryIds[0] = sqlynx.findCatalogDatabaseById(catalog, objectId.value.database, this.tmpDatabaseEntry);
                entryIds[1] = sqlynx.findCatalogSchemaById(catalog, objectId.value.schema, this.tmpSchemaEntry);
                entryIds[2] = sqlynx.findCatalogTableById(catalog, objectId.value.table, this.tmpTableEntry);
                if (entryIds[2] != null) {
                    const tableProto = catalog.tables(entryIds[2])!;
                    const tableChildrenBegin = tableProto.childBegin();
                    entryIds[3] = tableChildrenBegin + objectId.value.column;
                }
                break;
        }

        // Truncate nulls
        let notNullEntries = 0;
        for (; notNullEntries < entryIds.length && entryIds[notNullEntries] != null; ++notNullEntries);

        if (notNullEntries > 0) {
            // Update epoch and pin entries
            let wasOverflowing = [false, false, false, false];
            const levels = this.levels;
            for (let i = 0; i < notNullEntries - 1; ++i) {
                const entryId = entryIds[i]!;

                // Ping the entry
                wasOverflowing[i] = (levels[i].entryFlags[entryId] & CatalogRenderingFlag.OVERFLOW) != 0;
                levels[i].pinnedEntries.add(entryId);
                levels[i].pinnedInEpoch[entryId] = epoch;
                levels[i].entryFlags[entryId] |= flagsPath;

                // Update first focused (if appropriate)
                const firstFocusedEntry = levels[i].firstFocusedEntry;
                if ((flagsPath & PINNED_BY_FOCUS) != 0 && (firstFocusedEntry == null || firstFocusedEntry.epoch != epoch || entryId < firstFocusedEntry.entryId)) {
                    levels[i].firstFocusedEntry = {
                        epoch,
                        entryId: entryId,
                    };
                }
            }

            // Pin last entry
            const lastLevel = notNullEntries - 1;
            const lastEntryId = entryIds[lastLevel]!;
            wasOverflowing[lastLevel] = (levels[lastLevel].entryFlags[lastEntryId] & CatalogRenderingFlag.OVERFLOW) != 0;
            levels[lastLevel].pinnedEntries.add(lastEntryId);
            levels[lastLevel].pinnedInEpoch[lastEntryId] = epoch;
            levels[lastLevel].entryFlags[lastEntryId] |= flagsTarget;

            // Update first focused (if appropriate)
            const firstFocusedEntry = levels[lastLevel].firstFocusedEntry;
            if ((flagsPath & PINNED_BY_FOCUS) != 0 && (firstFocusedEntry == null || firstFocusedEntry.epoch != epoch || lastEntryId < firstFocusedEntry.entryId)) {
                levels[lastLevel].firstFocusedEntry = {
                    epoch,
                    entryId: lastEntryId,
                };
            }

            // Determine the parent of the first overflowing node
            if (wasOverflowing[0]) {
                this.pendingLayoutUpdates.root = true;
            } else if (wasOverflowing[1]) {
                this.pendingLayoutUpdates.databases.add(entryIds[0]!);
            } else if (wasOverflowing[2]) {
                this.pendingLayoutUpdates.schemas.add(entryIds[1]!);
            } else if (wasOverflowing[3]) {
                this.pendingLayoutUpdates.tables.add(entryIds[2]!);
            }
        }
    }

    // Unpin old entries.
    unpin(pinFlags: number, currentEpoch: number): void {
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
    pinScriptRefs(script: sqlynx.proto.AnalyzedScript): void {
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
                const objectId: QualifiedCatalogObjectID = {
                    type: QUALIFIED_TABLE_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                    }
                };
                this.pinPath(catalog, epoch, CatalogRenderingFlag.SCRIPT_TABLE_REF, CatalogRenderingFlag.SCRIPT_TABLE_REF_PATH, objectId);
            }
        }

        // Pin resolved column references
        for (let i = 0; i < script.expressionsLength(); ++i) {
            const expr = script.expressions(i, tmpExpression)!;
            if (expr.innerType() == sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression) {
                const resolved = expr.inner(tmpResolvedColumnRef) as sqlynx.proto.ResolvedColumnRefExpression;
                const objectId: QualifiedCatalogObjectID = {
                    type: QUALIFIED_TABLE_COLUMN_ID,
                    value: {
                        database: resolved.catalogDatabaseId(),
                        schema: resolved.catalogSchemaId(),
                        table: resolved.catalogTableId(),
                        column: resolved.columnId(),
                    }
                };
                this.pinPath(catalog, epoch, CatalogRenderingFlag.SCRIPT_COLUMN_REF, CatalogRenderingFlag.SCRIPT_COLUMN_REF_PATH, objectId);
            }
        }

        // Unpin all entries were pinned with the same flags in a previous epoch
        this.unpin(PINNED_BY_SCRIPT, epoch);
        // Now run all necessary layout updates
        this.layoutPendingEntries();
    }


    pinFocusedByUser(focus: UserFocus): void {
        const catalog = this.snapshot.read().catalogReader;
        const epoch = this.nextPinEpoch++;

        // Pin focused catalog objects
        for (const o of focus.catalogObjects) {
            let flagsTarget = 0;
            let flagsPath = 0;
            switch (o.focus) {
                case FocusType.COMPLETION_CANDIDATE:
                    flagsTarget = CatalogRenderingFlag.FOCUS_COMPLETION_CANDIDATE;
                    flagsPath = CatalogRenderingFlag.FOCUS_COMPLETION_CANDIDATE_PATH;
                    break;
                case FocusType.CATALOG_ENTRY:
                    flagsTarget = CatalogRenderingFlag.FOCUS_CATALOG_ENTRY;
                    flagsPath = CatalogRenderingFlag.FOCUS_CATALOG_ENTRY_PATH;
                    break;
                case FocusType.TABLE_REF:
                    flagsTarget = CatalogRenderingFlag.FOCUS_TABLE_REF;
                    flagsPath = CatalogRenderingFlag.FOCUS_TABLE_REF_PATH;
                    break;
                case FocusType.COLUMN_REF:
                    flagsTarget = CatalogRenderingFlag.FOCUS_COLUMN_REF;
                    flagsPath = CatalogRenderingFlag.FOCUS_COLUMN_REF_PATH;
                    break;
            }
            this.pinPath(catalog, epoch, flagsTarget, flagsPath, o);
        }
        // Unpin previous catalog objects
        this.unpin(PINNED_BY_FOCUS, epoch);
        // Now run all necessary layout updates
        this.layoutPendingEntries();
    }

    /// Determine the offset of the first focused element
    getOffsetOfFirstFocused(): number | null {
        const levels = this.levels;
        let maxEpoch = 0;
        let positionYFocused = null;
        for (let i = 0; i < levels.length; ++i) {
            const firstFocusedEntry = levels[i].firstFocusedEntry;
            if (firstFocusedEntry != null && firstFocusedEntry.epoch >= maxEpoch) {
                maxEpoch = firstFocusedEntry.epoch;
                positionYFocused = levels[i].positionsY[firstFocusedEntry.entryId];
            }
        }
        return positionYFocused;
    }
}
