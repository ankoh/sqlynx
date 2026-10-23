import type { SessionMigrationStep } from '../session_migration.js';

/// The order of the scripts and the database of each script live in the session metadata.
///
/// Version 4 ordered the scripts by a numeric prefix of their file names and listed the files in a
/// separate index for sessions served over HTTP. The index was kept in natural order, its order is
/// the order of the scripts. Every script runs on the main database. A folder without an index gets
/// empty lists, the loader appends the script files in natural order.
export const scriptsInSessionFile: SessionMigrationStep = {
    version: 5,
    description: 'List the scripts with their databases in the session metadata',
    async migrate(folder) {
        const text = await folder.readText('dashql-session.json');
        if (text == null) {
            return;
        }
        const data = JSON.parse(text) as Record<string, unknown>;
        if (!Array.isArray(data.scripts)) {
            const mainDatabase = data.mainDatabase as { databaseId?: unknown } | undefined;
            const index = parseIndex(await folder.readText('dashql-session-index.json'));
            const databaseId = typeof mainDatabase?.databaseId === 'string' ? mainDatabase.databaseId : null;
            data.scripts = databaseId == null ? [] : index.scripts.map(name => ({ name, databaseId }));
            data.attachments = index.data.map(name => ({ name }));
            await folder.writeText('dashql-session.json', JSON.stringify(data, null, 2));
        }
        await folder.remove('dashql-session-index.json');
    },
};

/// The file names of an index, an unreadable index lists nothing
function parseIndex(text: string | null): { scripts: string[]; data: string[] } {
    const names = (entries: unknown): string[] => Array.isArray(entries)
        ? entries.map(entry => (entry as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === 'string')
        : [];
    if (text == null) {
        return { scripts: [], data: [] };
    }
    try {
        const index = JSON.parse(text) as { scripts?: unknown; data?: unknown } | null;
        return { scripts: names(index?.scripts), data: names(index?.data) };
    } catch {
        return { scripts: [], data: [] };
    }
}
