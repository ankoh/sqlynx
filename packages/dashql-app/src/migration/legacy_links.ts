/// The names that links of older app versions use.
///
/// Links live outside of the storage and are never rewritten, they are read under every name they
/// ever had. The sessions the links point to are migrated by the session migration.

/// The query parameter that carried the URL of a hosted session before notebooks were called sessions
export const LEGACY_SESSION_QUERY_PARAMETER = 'notebook';
/// The name of the session metadata of a hosted session before notebooks were called sessions
export const LEGACY_SESSION_FILE = 'dashql-notebook.json';

/// Bring the app event of a link to the current names. Links of older versions embed the session
/// ZIP as `notebook` instead of `session`.
export function migrateAppEventData(data: unknown): unknown {
    if (data == null || typeof data !== 'object' || Array.isArray(data) || !('notebook' in data) || 'session' in data) {
        return data;
    }
    const { notebook, ...rest } = data as Record<string, unknown>;
    return { ...rest, session: notebook };
}
