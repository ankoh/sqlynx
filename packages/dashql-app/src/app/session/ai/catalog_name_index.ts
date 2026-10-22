import * as core from '@ankoh/dashql-core';

import { isSystemSchema } from '../connections/system_schemas.js';

/// Shorter words are never treated as identifiers in natural language
const MIN_IDENTIFIER_LENGTH = 3;

/// Function words that are never treated as identifiers in natural language, even if a table or column has that name
const STOP_WORDS = new Set([
    'all', 'and', 'any', 'are', 'but', 'can', 'could', 'did', 'does', 'each', 'find', 'for', 'from', 'get', 'give',
    'had', 'has', 'have', 'here', 'how', 'into', 'its', 'list', 'many', 'much', 'not', 'our', 'over', 'per', 'show',
    'should', 'some', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'those', 'top', 'was',
    'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'your',
]);

/// A word, optionally qualified with a dot (orders.amount)
const WORD_REGEX = /[\p{L}_][\p{L}\p{N}_$]*(?:\.[\p{L}_][\p{L}\p{N}_$]*)?/gu;

/// The kind of a catalog name
export enum CatalogNameKind {
    Table,
    Column,
}

/// A table or column name in the catalog
export interface CatalogName {
    /// The name as stored in the catalog
    name: string;
    /// The kind of the named object
    kind: CatalogNameKind;
    /// The table of a column, null for tables
    table: string | null;
}

/// A lookup structure for the table and column names of a catalog
export interface CatalogNameIndex {
    /// The distinct lowercase names, sorted for prefix searches
    keys: string[];
    /// The catalog names per lowercase name
    byKey: Map<string, CatalogName[]>;
    /// The lowercase column names per lowercase table name
    columnsByTable: Map<string, Set<string>>;
}

/// A word of a text that names a catalog object
export interface IdentifierMatch {
    /// The begin of the word
    from: number;
    /// The end of the word
    to: number;
    /// The kind of the named object, a qualified column is a column
    kind: CatalogNameKind;
    /// The matched catalog names
    names: CatalogName[];
}

/// An index without names
export const EMPTY_CATALOG_NAME_INDEX: CatalogNameIndex = { keys: [], byKey: new Map(), columnsByTable: new Map() };

/// Build the name index of a catalog, skipping the schemas of the database system.
/// Reads a fresh snapshot, the cached one misses the scripts that script sessions loaded into the catalog since.
export function buildCatalogNameIndex(catalog: core.DashQLCatalog): CatalogNameIndex {
    const byKey = new Map<string, CatalogName[]>();
    const columnsByTable = new Map<string, Set<string>>();
    const add = (name: CatalogName) => {
        const key = name.name.toLowerCase();
        const names = byKey.get(key);
        if (names == null) {
            byKey.set(key, [name]);
        } else {
            names.push(name);
        }
    };
    const snapshot = catalog.createUncachedSnapshot();
    try {
        const reader = snapshot.read();
        const flat = reader.catalogReader;
        const entry = new core.buffers.catalog.FlatCatalogEntry();
        // Every level references its parent by the index into the flat array of the level above
        const systemSchemas: boolean[] = [];
        for (let i = 0; i < flat.schemasLength(); ++i) {
            systemSchemas.push(isSystemSchema(reader.readName(flat.schemas(i, entry)!.nameId())));
        }
        const tableNames: (string | null)[] = [];
        for (let i = 0; i < flat.tablesLength(); ++i) {
            const table = flat.tables(i, entry)!;
            const name = reader.readName(table.nameId());
            if (systemSchemas[table.flatParentIdx()] || name.length === 0) {
                tableNames.push(null);
                continue;
            }
            tableNames.push(name);
            add({ name, kind: CatalogNameKind.Table, table: null });
        }
        for (let i = 0; i < flat.columnsLength(); ++i) {
            const column = flat.columns(i, entry)!;
            const table = tableNames[column.flatParentIdx()];
            const name = reader.readName(column.nameId());
            if (table == null || name.length === 0) {
                continue;
            }
            add({ name, kind: CatalogNameKind.Column, table });
            const tableKey = table.toLowerCase();
            let columns = columnsByTable.get(tableKey);
            if (columns == null) {
                columns = new Set();
                columnsByTable.set(tableKey, columns);
            }
            columns.add(name.toLowerCase());
        }
    } finally {
        snapshot.destroy();
    }
    const keys = [...byKey.keys()].sort();
    return { keys, byKey, columnsByTable };
}

/// Could a word be an identifier in natural language at all?
export function isIdentifierCandidate(word: string): boolean {
    return word.length >= MIN_IDENTIFIER_LENGTH && !STOP_WORDS.has(word.toLowerCase());
}

/// Find the catalog names of a word, dotted words must name a column of a table
export function lookupIdentifier(index: CatalogNameIndex, word: string): IdentifierMatch['names'] | null {
    const dot = word.indexOf('.');
    if (dot >= 0) {
        const table = word.substring(0, dot).toLowerCase();
        const column = word.substring(dot + 1).toLowerCase();
        if (!index.columnsByTable.get(table)?.has(column)) {
            return null;
        }
        return index.byKey.get(column)!.filter(name => name.kind === CatalogNameKind.Column && name.table?.toLowerCase() === table);
    }
    if (!isIdentifierCandidate(word)) {
        return null;
    }
    return index.byKey.get(word.toLowerCase()) ?? null;
}

/// Find the distinct lowercase names that start with a prefix, at most limit many
export function lookupPrefix(index: CatalogNameIndex, prefix: string, limit: number): string[] {
    const lower = prefix.toLowerCase();
    // Binary search the first key that is not smaller than the prefix
    let lo = 0;
    let hi = index.keys.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (index.keys[mid] < lower) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const matches: string[] = [];
    for (let i = lo; i < index.keys.length && matches.length < limit && index.keys[i].startsWith(lower); ++i) {
        matches.push(index.keys[i]);
    }
    return matches;
}

/// Find the words of a text that name catalog objects
export function findIdentifierMatches(index: CatalogNameIndex, text: string): IdentifierMatch[] {
    const matches: IdentifierMatch[] = [];
    for (const word of text.matchAll(WORD_REGEX)) {
        const names = lookupIdentifier(index, word[0]);
        if (names == null || names.length === 0) {
            continue;
        }
        matches.push({
            from: word.index,
            to: word.index + word[0].length,
            kind: names.some(name => name.kind === CatalogNameKind.Table) ? CatalogNameKind.Table : CatalogNameKind.Column,
            names,
        });
    }
    return matches;
}

/// Describe the catalog objects that a text mentions, e.g. "orders (table)" or "amount (column of orders)"
export function collectMentionedIdentifiers(index: CatalogNameIndex, text: string): string[] {
    const mentioned = new Set<string>();
    for (const match of findIdentifierMatches(index, text)) {
        const tables = new Set<string>();
        const columns = new Map<string, Set<string>>();
        for (const name of match.names) {
            if (name.kind === CatalogNameKind.Table) {
                tables.add(name.name);
            } else {
                let owners = columns.get(name.name);
                if (owners == null) {
                    owners = new Set();
                    columns.set(name.name, owners);
                }
                if (name.table != null) owners.add(name.table);
            }
        }
        for (const table of tables) {
            mentioned.add(`${table} (table)`);
        }
        for (const [column, owners] of columns) {
            mentioned.add(owners.size > 0 ? `${column} (column of ${[...owners].join(', ')})` : `${column} (column)`);
        }
    }
    return [...mentioned];
}
