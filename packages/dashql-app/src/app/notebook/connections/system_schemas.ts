/// Schemas of the database system rather than of the user
const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);
/// Prefixes of schemas of the database system, e.g. pg_toast or pg_temp_3
const SYSTEM_SCHEMA_PREFIXES = ['pg_toast', 'pg_temp'];

/// Is a schema part of the database system rather than of the user?
export function isSystemSchema(schemaName: string): boolean {
    const lower = schemaName.toLowerCase();
    return SYSTEM_SCHEMAS.has(lower) || SYSTEM_SCHEMA_PREFIXES.some(prefix => lower.startsWith(prefix));
}
