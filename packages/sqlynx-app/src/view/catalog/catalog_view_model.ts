import * as sqlynx from '@ankoh/sqlynx-core';
import { insertSorted, SortedElement } from '../../utils/sorted.js';

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
    PINNED = 0b10,
    PINNED_BY_SCRIPT_TABLE_REFS = 0b100,
    PINNED_BY_SCRIPT_COLUMN_REFS = 0b1000,
    PINNED_BY_SCRIPT_CURSOR = 0b10000,
    PRIMARY_FOCUS = 0b100000,
}

/// A span of catalog entries
interface CatalogEntrySpan {
    read(snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry): sqlynx.proto.FlatCatalogEntry | null;
    length(snap: sqlynx.SQLynxCatalogSnapshotReader): number;
}

/// A pinned catalog entry
export class PinnedCatalogEntry implements SortedElement {
    /// The sort key
    sortKey: number;

    /// The level id
    levelId: number;

    /// The object id
    objectId: bigint;
    /// The entry id in the catalog
    catalogEntryId: number;
    /// The parent object id
    parentObjectId: bigint | null;
    /// The entry id of the parent in the catalog
    parentCatalogEntryId: number | null;

    /// Was pinned by a user focus?
    pinnedInEpoch: bigint;
    /// The pinned children, ordered by catalog entry id
    pinnedChildren: PinnedCatalogEntry[];

    constructor(levelId: number, objectId: bigint, catalogEntryId: number, parentObjectId: bigint | null = null, parentCatalogEntryId: number | null = null) {
        this.sortKey = catalogEntryId;
        this.levelId = levelId;
        this.objectId = objectId;
        this.catalogEntryId = catalogEntryId;
        this.parentObjectId = parentObjectId;
        this.parentCatalogEntryId = parentCatalogEntryId;
        this.pinnedInEpoch = 0n;
        this.pinnedChildren = [];
    }
}

interface CatalogLevelViewModel {
    /// The rendering settings
    settings: CatalogLevelRenderingSettings;
    /// The buffers
    entries: CatalogEntrySpan;
    /// The rendering flags
    entryFlags: Uint8Array;
    /// The subtree heights
    subtreeHeights: Float32Array;
    /// The overflow child counts
    overflowChildCounts: Uint32Array;
    /// The x offset
    positionX: number;
    /// The y positions as written during rendering (if visible)
    positionsY: Float32Array;
    /// The epochs in which this node was rendered
    renderingEpochs: Uint32Array;
    /// The scratch catalog entry
    scratchEntry: sqlynx.proto.FlatCatalogEntry;
}

interface RenderingContext {
    /// The snapshot
    snapshot: sqlynx.SQLynxCatalogSnapshotReader;
    /// The current writer
    currentWriterY: number;
    /// The number of overflowing children
    overflowChildCount: number
};

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

    /// The ordered pinned entries at the root;
    pinnedEntriesAtRoot: PinnedCatalogEntry[];
    /// The number of overflowing entries at the root level
    overflowingEntriesAtRoot: number;

    /// The next rendering epoch
    nextRenderingEpoch: number;
    /// The pin epoch counter
    nextPinEpoch: bigint;

    /// The pinned databases
    pinnedDatabasesMap: Map<number, PinnedCatalogEntry>;
    /// The pinned schemas
    pinnedSchemasMap: Map<number, PinnedCatalogEntry>;
    /// The pinned tables
    pinnedTablesMap: Map<bigint, PinnedCatalogEntry>;
    /// The pinned columns
    pinnedTableColumnsMap: Map<bigint, PinnedCatalogEntry>;

    /// The total height of all nodes
    totalHeight: number;
    /// The total width of all nodes
    totalWidth: number;

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
        this.nextPinEpoch = 1n;
        this.pinnedDatabasesMap = new Map();
        this.pinnedSchemasMap = new Map();
        this.pinnedTablesMap = new Map();
        this.pinnedTableColumnsMap = new Map();
        const snap = snapshot.read();
        this.databaseEntries = {
            settings: settings.levels.databases,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.databases(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.databasesLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.databasesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.databasesLength()),
            overflowChildCounts: new Uint32Array(snap.catalogReader.databasesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.databasesLength()),
            renderingEpochs: new Uint32Array(snap.catalogReader.databasesLength()),
        };
        this.schemaEntries = {
            settings: settings.levels.schemas,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.schemas(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.schemasLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.schemasLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.schemasLength()),
            overflowChildCounts: new Uint32Array(snap.catalogReader.schemasLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.schemasLength()),
            renderingEpochs: new Uint32Array(snap.catalogReader.schemasLength()),
        };
        this.tableEntries = {
            settings: settings.levels.tables,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.tables(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.tablesLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.tablesLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.tablesLength()),
            overflowChildCounts: new Uint32Array(snap.catalogReader.tablesLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.tablesLength()),
            renderingEpochs: new Uint32Array(snap.catalogReader.tablesLength()),
        };
        this.columnEntries = {
            settings: settings.levels.columns,
            entries: {
                read: (snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry) => snap.catalogReader.columns(index, obj),
                length: (snap: sqlynx.SQLynxCatalogSnapshotReader) => snap.catalogReader.columnsLength(),
            },
            entryFlags: new Uint8Array(snap.catalogReader.columnsLength()),
            subtreeHeights: new Float32Array(snap.catalogReader.columnsLength()),
            overflowChildCounts: new Uint32Array(snap.catalogReader.columnsLength()),
            positionX: 0,
            scratchEntry: new sqlynx.proto.FlatCatalogEntry(),
            positionsY: new Float32Array(snap.catalogReader.columnsLength()),
            renderingEpochs: new Uint32Array(snap.catalogReader.columnsLength()),
        };
        this.schemaEntries.positionX = settings.levels.databases.nodeWidth + settings.levels.databases.columnGap;
        this.tableEntries.positionX = this.schemaEntries.positionX + settings.levels.schemas.nodeWidth + settings.levels.schemas.columnGap;
        this.columnEntries.positionX = this.tableEntries.positionX + settings.levels.tables.nodeWidth + settings.levels.tables.columnGap;


        this.pinnedEntriesAtRoot = [];
        this.overflowingEntriesAtRoot = 0;

        this.totalWidth = 0;
        this.totalHeight = 0;

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

    /// Layout entries at a level
    static layoutLevelEntries(ctx: RenderingContext, levels: CatalogLevelViewModel[], levelId: number, entriesBegin: number, entriesCount: number) {
        const level = levels[levelId];
        let unpinnedChildCount = 0;
        let overflowChildCount = 0;
        let isFirstEntry = true;

        for (let i = 0; i < entriesCount; ++i) {
            const entryId = entriesBegin + i;
            const entry = level.entries.read(ctx.snapshot, entryId, level.scratchEntry)!;
            const entryFlags = level.entryFlags[entryId];

            // PINNED and DEFAULT entries have the same height, so it doesn't matter that we're accounting for them here in the "wrong" order.

            // Skip the node if the node is UNPINNED and the child count hit the limit
            if ((entryFlags & CatalogRenderingFlag.PINNED) == 0) {
                ++unpinnedChildCount;
                if (unpinnedChildCount > level.settings.maxUnpinnedChildren) {
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
                this.layoutLevelEntries(ctx, levels, levelId + 1, entry.childBegin(), entry.childCount());
            }
            // Bump writer if the columns didn't already
            ctx.currentWriterY = Math.max(ctx.currentWriterY, thisPosY + level.settings.nodeHeight);
            // Store the subtree height
            // Note that we deliberately do not include the entries row gap here.
            // If we would, we couldn't update this easily from the children.
            // (We would have to know if our parent is the child)
            level.subtreeHeights[entryId] = ctx.currentWriterY - thisPosY;
            // Store the number of overflowing children.
            // Remembering the number of overflowing children allows us to update more easily after pinning/unpinning
            level.overflowChildCounts[entryId] = ctx.overflowChildCount;
        }

        // Store overflow child count
        ctx.overflowChildCount = overflowChildCount;

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
        const ctx: RenderingContext = {
            snapshot: snap,
            currentWriterY: 0,
            overflowChildCount: 0,
        };
        CatalogViewModel.layoutLevelEntries(ctx, this.levels, 0, 0, databaseCount);
        this.overflowingEntriesAtRoot = ctx.overflowChildCount;
        this.totalHeight = ctx.currentWriterY;
        this.totalWidth = this.columnEntries.positionX + this.settings.levels.columns.nodeWidth + this.settings.levels.columns.columnGap;
    }

    /// Update the scroll window
    updateWindow(begin: number, end: number, virtualBegin: number, virtualEnd: number) {
        this.scrollBegin = begin;
        this.scrollEnd = end;
        this.virtualScrollBegin = virtualBegin;
        this.virtualScrollEnd = virtualEnd;
    }

    /// Pin an element
    ///
    /// When pinning, we're getting a column key prefix with up to 4 components.
    /// That means we might pin:
    ///  - A database
    ///  - A database and a schema
    ///  - A database, a schema and a table
    ///  - A database, a schema, a table and a column
    ///
    /// We first have to collect all catalog entries for every pinned level.
    /// Note that some, maybe even all, of the the entries might already be pinned or at least visible.
    ///
    /// Once we have collected all entries, we have to check which of the elements were previously visible.
    /// An element was not visible if it was marked as OVERFLOW.
    ///  - If an element IS NOT marked with OVERFLOW, we know it was already visible.
    ///    Already visible elements had their children laid out, which means that PINNING such an element is not adding NEW children apart from pinned ones.
    ///    This means that we do NOT need to layout the entire node subtree but are fine with only updating the parent subtree height, great!
    ///  - If an element IS marked with OVERFLOW, it was hidden before.
    ///    This means that we have to recursively layout all the children.
    ///
    /// Laying out a node is a recursive operation that will lay out all descending child nodes.
    /// This means that we only have to find the FIRST component in the key path that was marked with OVERFLOW.
    /// That node we then layout after explicitly marking all descending nodes in the path as pinned.
    pin(catalog: sqlynx.proto.FlatCatalog,
        epoch: bigint,
        flags: number,
        dbId: number,
        schemaId: number | null,
        tableId: bigint | null,
        columnId: number | null,
    ) {
        // First collect (or create) all catalog entries
        let db: PinnedCatalogEntry | null = null;
        let schema: PinnedCatalogEntry | null = null;
        let table: PinnedCatalogEntry | null = null;
        let column: PinnedCatalogEntry | null = null;

        // Remember catalog entries that were previously visible and the first that was not
        let pinnedThatWereVisible: PinnedCatalogEntry[] = [];
        let pathLength = 1;

        // Is the database already pinned?
        db = this.pinnedDatabasesMap.get(dbId) ?? null;
        if (db == null) {
            // Lookup the database id in the catalog
            const catalogDbId = sqlynx.findCatalogDatabaseById(catalog, dbId, this.tmpDatabaseEntry);
            if (catalogDbId == null) {
                // Failed to locate database in the catalog?
                // Skip this entry
                return;
            }
            db = new PinnedCatalogEntry(0, BigInt(dbId), catalogDbId);
            db.pinnedInEpoch = epoch;
            this.databaseEntries.entryFlags[db.catalogEntryId] |= CatalogRenderingFlag.PINNED | flags;
            this.pinnedDatabasesMap.set(dbId, db);
            insertSorted(this.pinnedEntriesAtRoot, db);
        }

        // Check if the database was overflowing before
        const dbWasOverflowing = (this.databaseEntries.entryFlags[db.catalogEntryId] & CatalogRenderingFlag.OVERFLOW) != 0;
        if (!dbWasOverflowing) {
            pinnedThatWereVisible.push(db);
        }
        this.databaseEntries.entryFlags[db.catalogEntryId] &= ~CatalogRenderingFlag.OVERFLOW;

        // Resolve schema
        if (schemaId != null) {
            ++pathLength;

            // Is the schema already pinned?
            schema = this.pinnedSchemasMap.get(schemaId) ?? null;
            if (schema == null) {
                // Lookup the schema id in the catalog
                const catalogSchemaId = sqlynx.findCatalogSchemaById(catalog, schemaId, this.tmpSchemaEntry);
                if (catalogSchemaId == null) {
                    // Failed to locate schema in the catalog?
                    // Skip this entry
                    return;
                }
                schema = new PinnedCatalogEntry(1, BigInt(schemaId), catalogSchemaId, db.objectId, db.catalogEntryId);
                schema.pinnedInEpoch = epoch;
                this.schemaEntries.entryFlags[schema.catalogEntryId] |= CatalogRenderingFlag.PINNED | flags;
                this.pinnedSchemasMap.set(schemaId, schema);
                insertSorted(db.pinnedChildren, schema);
            }

            // Check if the schema was overflowing before
            const schemaWasOverflowing = (this.schemaEntries.entryFlags[schema.catalogEntryId] & CatalogRenderingFlag.OVERFLOW) != 0;
            if (!schemaWasOverflowing) {
                pinnedThatWereVisible.push(schema);
            }
            this.schemaEntries.entryFlags[schema.catalogEntryId] &= ~CatalogRenderingFlag.OVERFLOW;

            // Resolve the table
            if (tableId != null) {
                ++pathLength;

                // Is the table already pinned?
                table = this.pinnedTablesMap.get(tableId) ?? null;
                if (table == null) {
                    // Lookup the table id in the catalog
                    const catalogTableId = sqlynx.findCatalogTableById(catalog, tableId, this.tmpTableEntry);
                    if (catalogTableId == null) {
                        // Failed to locate table in the catalog?
                        // Skip this entry
                        return;
                    }
                    table = new PinnedCatalogEntry(2, BigInt(tableId), catalogTableId, schema.objectId, schema.catalogEntryId);
                    table.pinnedInEpoch = epoch;
                    this.tableEntries.entryFlags[table.catalogEntryId] |= CatalogRenderingFlag.PINNED | flags;
                    this.pinnedTablesMap.set(tableId, table);
                    insertSorted(schema.pinnedChildren, table);
                }

                // Check if the table was overflowing before
                const tableWasOverflowing = (this.tableEntries.entryFlags[table.catalogEntryId] & CatalogRenderingFlag.OVERFLOW) != 0;
                if (!tableWasOverflowing) {
                    pinnedThatWereVisible.push(table);
                }
                this.tableEntries.entryFlags[table.catalogEntryId] &= ~CatalogRenderingFlag.OVERFLOW;

                // Resolve the column
                if (columnId != null) {
                    ++pathLength;

                    // Columns are only ever accessed through the table in the catalog.
                    // But we can index them using a derived child id using (table id, column idx)
                    const combinedColumnId = sqlynx.ExternalObjectChildID.create(tableId, columnId);

                    // Is the column already pinned?
                    column = this.pinnedTableColumnsMap.get(combinedColumnId) ?? null;
                    if (column == null) {
                        const tableProto = catalog.tables(table.catalogEntryId)!;
                        const tableChildrenBegin = tableProto.childBegin();
                        const catalogColumnId = tableChildrenBegin + columnId;
                        column = new PinnedCatalogEntry(3, combinedColumnId, catalogColumnId, table.objectId, table.catalogEntryId);
                        column.pinnedInEpoch = epoch;
                        this.columnEntries.entryFlags[column.catalogEntryId] |= CatalogRenderingFlag.PINNED | flags;
                        this.pinnedTableColumnsMap.set(combinedColumnId, column);
                        insertSorted(table.pinnedChildren, column);
                    }

                    // Check if the column was overflowing before
                    const columnWasOverflowing = (this.columnEntries.entryFlags[column.catalogEntryId] & CatalogRenderingFlag.OVERFLOW) != 0;
                    if (!columnWasOverflowing) {
                        pinnedThatWereVisible.push(column);
                    }
                    this.columnEntries.entryFlags[column.catalogEntryId] &= ~CatalogRenderingFlag.OVERFLOW;
                }
            }
        }

        // Full visible? Nothing to do then
        if (pinnedThatWereVisible.length == pathLength) {
            return;
        }

        // Were there any already visible elements along the path?
        if (pinnedThatWereVisible.length > 0) {
            const levels = this.levels;
            // Re-layout the last visible node
            const lastVisible = pinnedThatWereVisible[pinnedThatWereVisible.length - 1];
            const snap = this.snapshot.read();
            const ctx: RenderingContext = {
                snapshot: snap,
                currentWriterY: 0,
                overflowChildCount: 0
            };
            const previousHeight = levels[lastVisible.levelId].subtreeHeights[lastVisible.catalogEntryId];
            CatalogViewModel.layoutLevelEntries(ctx, levels, lastVisible.levelId, lastVisible.catalogEntryId, 1);
            const newHeight = ctx.currentWriterY;
            const heightDelta = newHeight - previousHeight;

            // Propagate the height delta upwards
            for (let i = pinnedThatWereVisible.length - 1; i > 0; --i) {
                const entry = pinnedThatWereVisible[i - 1];
                levels[entry.levelId].subtreeHeights[entry.catalogEntryId] += heightDelta;
            }
            // Adjust the total tree height
            this.totalHeight += heightDelta;
            // Update the overflow count of the last visible node
            --levels[lastVisible.levelId].overflowChildCounts[lastVisible.catalogEntryId];

        } else {
            // Otherwise re-layout everything
            this.layoutEntries();
        }
    }

    // Cleanup old pins.
    //
    // When pinning elements, we provide an increasing epoch counter.
    // This epoch counter will be increased with every bulk update.
    // For example, when updating elements that are pinned through script refs, we iterate through all refs and pin elements with the same epoch.
    // Afterwards, we can then iterate over all currently pinned elements and collect those that were pinned with the same flags but an older epoch.
    // We clear the flags and if there are no flags left, we'll remove the pin completely.
    //
    // By removing a pin, the node might start to overflow and disappear from the rendered catalog.
    // In such a case we have to layout the unpinned parent.
    unpinOld(flags: number, epoch: bigint) {
        // XXX
    }


    // Pin all script refs
    pinScriptRefs(script: sqlynx.proto.AnalyzedScript) {
        const catalog = this.snapshot.read().catalogReader;
        const tmpTableRef = new sqlynx.proto.TableReference();
        const tmpColumnRef = new sqlynx.proto.ColumnReference();

        // Allocate an epoch
        const epoch = this.nextPinEpoch++;

        // Pin table references
        for (let i = 0; i < script.tableReferencesLength(); ++i) {
            const tableRef = script.tableReferences(i, tmpTableRef)!;
            const dbId = tableRef.resolvedCatalogDatabaseId();
            const schemaId = tableRef.resolvedCatalogSchemaId();
            const tableId = tableRef.resolvedCatalogTableId();
            this.pin(catalog, epoch, CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS, dbId, schemaId, tableId, null);
        }

        // Pin column references
        for (let i = 0; i < script.columnReferencesLength(); ++i) {
            const columnRef = script.columnReferences(i, tmpColumnRef)!;
            const dbId = columnRef.resolvedCatalogDatabaseId();
            const schemaId = columnRef.resolvedCatalogSchemaId();
            const tableId = columnRef.resolvedCatalogTableId();
            const columnId = columnRef.resolvedColumnId();
            this.pin(catalog, epoch, CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS, dbId, schemaId, tableId, columnId);
        }

        // Unpin all entries were pinned with the same flags in a previous epoch
        this.unpinOld(CatalogRenderingFlag.PINNED_BY_SCRIPT_TABLE_REFS | CatalogRenderingFlag.PINNED_BY_SCRIPT_COLUMN_REFS, epoch);
    }


    pinCursorRefs(cursor: sqlynx.proto.ScriptCursorInfo) {
        // Allocate an epoch
        const epoch = this.nextPinEpoch++;

        // Unpin all cursor refs that were pinned in a previous epoch
        this.unpinOld(CatalogRenderingFlag.PINNED_BY_SCRIPT_CURSOR, epoch);
    }
}
