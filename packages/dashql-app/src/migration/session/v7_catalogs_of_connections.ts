import type { SessionMigrationStep } from '../session_migration.js';

/// Sessions no longer copy the catalog of their connection, the connection holds the only one.
///
/// Version 6 kept a copy of the catalog of the default connection in the session folder. The storage
/// step `sessionCatalogsToConnections` seeds connections without a catalog from those copies before
/// the copies are removed.
export const catalogsOfConnections: SessionMigrationStep = {
    version: 7,
    description: 'Remove the catalog copies of the session',
    async migrate(folder) {
        await folder.remove('dashql-catalog-relations.sql');
        await folder.remove('dashql-catalog-functions.sql');
        await folder.remove('dashql-catalog-changes.sql');
    },
};
