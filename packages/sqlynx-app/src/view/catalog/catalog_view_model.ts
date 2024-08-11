import * as sqlynx from '@ankoh/sqlynx-core';
import { EdgePathBuilder } from './graph_edges.js';
import { DerivedFocus } from 'session/focus.js';
import { F64_MAX_INTEGER, I64_MAX } from '../../utils/numeric_limits.js';

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
export enum NodeFlags {
    DEFAULT = 0,
    PINNED = 0b1,
    OVERFLOW = 0b10,
    SCRIPT_FOCUS = 0b100,
    CATALOG_FOCUS = 0b1000,
    DIRECT_FOCUS = 0b10000,
}

/// Helper to get the rendering mode.
export function readNodeFlags(modes: Uint8Array, index: number): NodeFlags {
    return (modes[index]) as NodeFlags;
}
/// Helper to set the rendering mode.
export function writeNodeFlags(modes: Uint8Array, index: number, node: NodeFlags) {
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

/// A span of catalog entries
interface CatalogEntrySpan {
    read(snap: sqlynx.SQLynxCatalogSnapshotReader, index: number, obj?: sqlynx.proto.FlatCatalogEntry): sqlynx.proto.FlatCatalogEntry | null;
    length(snap: sqlynx.SQLynxCatalogSnapshotReader): number;
}

enum PinReason {
    USER_FOCUS = 0b1,
    SCRIPT_REFS = 0b10
}

/// A pinned catalog entry
export class PinnedCatalogEntry {
    /// The object id
    objectId: bigint;
    /// The entry id in the catalog
    catalogEntryId: number;
    /// The parent object id
    parentObjectId: bigint | null;

    /// Was pinned by a user focus?
    pinnedByFocusInEpoch: bigint;
    /// Was pinned by a script ref?
    pinnedByScriptRefsInEpoch: bigint;
    /// The pinned children
    pinnedChildren: Map<bigint, PinnedCatalogEntry>;

    /// When rendering this node, what's the height of this subtree?
    renderingHeight: number;

    constructor(objectId: bigint, catalogEntryId: number, parentObjectId: bigint | null = null) {
        this.objectId = objectId;
        this.catalogEntryId = catalogEntryId;
        this.parentObjectId = parentObjectId;
        this.pinnedByFocusInEpoch = 0n;
        this.pinnedByScriptRefsInEpoch = 0n;
        this.pinnedChildren = new Map();
        this.renderingHeight = 0;
    }

    pin(epoch: bigint, reason: PinReason) {
        switch (reason) {
            case PinReason.USER_FOCUS:
                this.pinnedByFocusInEpoch = epoch;
                break;
            case PinReason.SCRIPT_REFS:
                this.pinnedByScriptRefsInEpoch = epoch;
                break;
        }
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

    /// The database entries
    databaseEntries: CatalogLevelRenderingState;
    /// The schema entries
    schemaEntries: CatalogLevelRenderingState;
    /// The table entries
    tableEntries: CatalogLevelRenderingState;
    /// The column entries
    columnEntries: CatalogLevelRenderingState;

    /// The pin epoch
    nextPinEpoch: bigint;
    /// The pinned databases
    pinnedDatabases: Map<number, PinnedCatalogEntry>;
    /// The pinned schemas
    pinnedSchemas: Map<number, PinnedCatalogEntry>;
    /// The pinned tables
    pinnedTables: Map<bigint, PinnedCatalogEntry>;
    /// The pinned columns
    pinnedTableColumns: Map<bigint, PinnedCatalogEntry>;


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

    /// The edge builder
    edgeBuilder: EdgePathBuilder;

    /// A temporary database object
    tmpDatabaseEntry: sqlynx.proto.IndexedFlatDatabaseEntry,
    /// A temporary schema object
    tmpSchemaEntry: sqlynx.proto.IndexedFlatSchemaEntry,
    /// A temporary table object
    tmpTableEntry: sqlynx.proto.IndexedFlatTableEntry

    constructor(snapshot: sqlynx.SQLynxCatalogSnapshot, settings: CatalogRenderingSettings) {
        this.snapshot = snapshot;
        this.settings = settings;
        this.nextPinEpoch = 0n;
        this.pinnedDatabases = new Map();
        this.pinnedSchemas = new Map();
        this.pinnedTables = new Map();
        this.pinnedTableColumns = new Map();
        const snap = snapshot.read();
        this.databaseEntries = {
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
        };
        this.schemaEntries = {
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
        };
        this.tableEntries = {
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
        };
        this.columnEntries = {
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
        };
        this.schemaEntries.positionX = settings.levels.databases.nodeWidth + settings.levels.databases.columnGap;
        this.tableEntries.positionX = this.schemaEntries.positionX + settings.levels.schemas.nodeWidth + settings.levels.schemas.columnGap;
        this.columnEntries.positionX = this.tableEntries.positionX + settings.levels.tables.nodeWidth + settings.levels.tables.columnGap;

        this.totalWidth = 0;
        this.totalHeight = 0;
        this.currentWriterY = 0;
        this.currentRenderingPath = new RenderingKey();
        this.currentRenderingWindow = new ScrollRenderingWindow();
        this.edgeBuilder = new EdgePathBuilder();

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

    /// Layout unpinned entries and assign them NodeFlags
    layoutEntriesAtLevel(snapshot: sqlynx.SQLynxCatalogSnapshotReader, levelId: number, entriesBegin: number, entriesCount: number) {
        const level = this.levels[levelId];
        const settings = level.settings;
        const entries = level.entries;
        const scratchEntry = level.scratchEntry;
        const subtreeHeights = level.subtreeHeights;
        const flags = level.flags;

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
            this.currentRenderingPath.select(levelId, entryId);
            const isFirstEntry = this.currentRenderingPath.isFirst[levelId];
            // The begin of the subtree
            let subtreeBegin = this.currentWriterY;
            // Add row gap when first
            this.currentWriterY += isFirstEntry ? 0 : settings.rowGap;
            // Remember own position
            let thisPosY = this.currentWriterY;
            // Render child columns
            if (entry.childCount() > 0) {
                this.layoutEntriesAtLevel(snapshot, levelId + 1, entry.childBegin(), entry.childCount());
            }
            // Bump writer if the columns didn't already
            this.currentWriterY = Math.max(this.currentWriterY, thisPosY + settings.nodeHeight);
            // Truncate the rendering path
            this.currentRenderingPath.truncate(levelId);
            // Store the subtree height
            subtreeHeights[entryId] = this.currentWriterY - subtreeBegin;
        }

        // Add space for the overflow node
        if (overflowChildCount > 0) {
            this.currentWriterY += settings.rowGap;
            this.currentWriterY += settings.nodeHeight;
        }
    }

    layoutEntries() {
        const snap = this.snapshot.read();
        const databaseCount = this.databaseEntries.entries.length(snap);
        this.layoutEntriesAtLevel(snap, 0, 0, databaseCount);
        this.totalHeight = this.currentWriterY;
        this.totalWidth = this.columnEntries.positionX + this.settings.levels.columns.nodeWidth + this.settings.levels.columns.columnGap;
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

    pin(catalog: sqlynx.proto.FlatCatalog,
        epoch: bigint,
        reason: PinReason,
        dbId: number,
        schemaId: number,
        tableId: bigint,
        columnId: number | null,
    ) {
        // Is the database already pinned?
        let db = this.pinnedDatabases.get(dbId);
        if (db == null) {
            // Lookup the database id in the catalog
            const catalogDbId = sqlynx.findCatalogDatabaseById(catalog, dbId, this.tmpDatabaseEntry);
            if (catalogDbId == null) {
                // Failed to locate database in the catalog?
                // Skip this entry
                return;
            }
            db = new PinnedCatalogEntry(BigInt(dbId), catalogDbId);
        }
        db.pin(epoch, reason);

        // Is the schema already pinned?
        let schema = this.pinnedSchemas.get(schemaId);
        if (schema == null) {
            // Lookup the schema id in the catalog
            const catalogSchemaId = sqlynx.findCatalogSchemaById(catalog, schemaId, this.tmpSchemaEntry);
            if (catalogSchemaId == null) {
                // Failed to locate schema in the catalog?
                // Skip this entry
                return;
            }
            schema = new PinnedCatalogEntry(BigInt(schemaId), catalogSchemaId, db.objectId);
            db.pinnedChildren.set(BigInt(schemaId), schema);
        }
        schema.pin(epoch, reason);

        // Is the table already pinned?
        let table = this.pinnedTables.get(tableId);
        if (table == null) {
            // Lookup the table id in the catalog
            const catalogTableId = sqlynx.findCatalogTableById(catalog, tableId, this.tmpTableEntry);
            if (catalogTableId == null) {
                // Failed to locate table in the catalog?
                // Skip this entry
                return;
            }
            table = new PinnedCatalogEntry(BigInt(tableId), catalogTableId, schema.objectId);
            schema.pinnedChildren.set(BigInt(tableId), table);
        }
        table.pin(epoch, reason);

        // No column provided?
        if (columnId == null) {
            return;
        }

        // Columns are only ever accessed through the table in the catalog.
        // But we can index them using a derived child id using (table id, column idx)
        const combinedColumnId = sqlynx.ExternalObjectChildID.create(tableId, columnId);

        // Is the column already pinned?
        let column = this.pinnedTableColumns.get(combinedColumnId);
        if (column == null) {
            const tableProto = catalog.tables(table.catalogEntryId)!;
            const tableChildrenBegin = tableProto.childBegin();
            const catalogColumnId = tableChildrenBegin + columnId;
            column = new PinnedCatalogEntry(combinedColumnId, catalogColumnId, table.objectId);
            table.pinnedChildren.set(combinedColumnId, column);
        }
        column.pin(epoch, reason);
    }

    pinScriptRefs(script: sqlynx.proto.AnalyzedScript, reason: PinReason, epoch: bigint) {
        const catalog = this.snapshot.read().catalogReader;
        const tmpTableRef = new sqlynx.proto.TableReference();
        const tmpColumnRef = new sqlynx.proto.ColumnReference();

        // Pin table references
        for (let i = 0; i < script.tableReferencesLength(); ++i) {
            const tableRef = script.tableReferences(i, tmpTableRef)!;
            const dbId = tableRef.resolvedCatalogDatabaseId();
            const schemaId = tableRef.resolvedCatalogSchemaId();
            const tableId = tableRef.resolvedCatalogTableId();
            this.pin(catalog, epoch, reason, dbId, schemaId, tableId, null);
        }

        // Pin column references
        for (let i = 0; i < script.columnReferencesLength(); ++i) {
            const columnRef = script.columnReferences(i, tmpColumnRef)!;
            const dbId = columnRef.resolvedCatalogDatabaseId();
            const schemaId = columnRef.resolvedCatalogSchemaId();
            const tableId = columnRef.resolvedCatalogTableId();
            const columnId = columnRef.resolvedColumnId();
            this.pin(catalog, epoch, reason, dbId, schemaId, tableId, columnId);
        }
    }

    pinCursorRefs(cursor: sqlynx.proto.ScriptCursorInfo, epoch: bigint) {

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

