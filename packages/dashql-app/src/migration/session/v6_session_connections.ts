import type { SessionMigrationStep } from '../session_migration.js';

/// The databases of a session become one list of connections with a default connection.
///
/// Version 5 referenced a main database and a list of attached databases, the scripts named their
/// database by its databaseId. The main database is the default connection, the databases keep
/// their ids as connection ids and their order, main database first.
export const sessionConnections: SessionMigrationStep = {
    version: 6,
    description: 'List the databases of the session as connections with a default connection',
    async migrate(folder) {
        const text = await folder.readText('dashql-session.json');
        if (text == null) {
            return;
        }
        const data = JSON.parse(text) as Record<string, unknown>;
        if (Array.isArray(data.connections)) {
            return;
        }
        const mainDatabase = data.mainDatabase as Record<string, unknown> | undefined;
        const attachedDatabases = Array.isArray(data.attachedDatabases) ? data.attachedDatabases as unknown[] : [];
        const connections = [mainDatabase, ...attachedDatabases].flatMap(database => {
            if (database == null || typeof database !== 'object') return [];
            const { databaseId, ...rest } = database as Record<string, unknown>;
            return [{ connectionId: databaseId, ...rest }];
        });
        const fields = {
            defaultConnectionId: typeof mainDatabase?.databaseId === 'string' ? mainDatabase.databaseId : null,
            connections,
        };
        // The connections take the place of the main database in the metadata
        const migrated: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
            if (key === 'mainDatabase') {
                Object.assign(migrated, fields);
            } else if (key === 'scripts' && Array.isArray(value)) {
                migrated.scripts = value.map(script => {
                    if (script == null || typeof script !== 'object') return script;
                    const { databaseId, ...rest } = script as Record<string, unknown>;
                    return { ...rest, connectionId: databaseId };
                });
            } else if (key !== 'attachedDatabases') {
                migrated[key] = value;
            }
        }
        if (!('mainDatabase' in data)) Object.assign(migrated, fields);
        await folder.writeText('dashql-session.json', JSON.stringify(migrated, null, 2));
    },
};
