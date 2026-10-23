import { stringifyError } from '../../platform/logger/logger.js';
import { OPFSFolder } from '../migration_folder.js';
import { migrateSessionFolder } from '../session_migration.js';
import type { StorageMigrationStep } from '../storage_migration.js';
import { listSessionFolders, readManifestJson } from '../storage_root.js';

const LOG_CTX = 'storage_migration';

/// The session format version the step reads, the next session step removes the catalog copies
const SESSION_FORMAT_VERSION = 6;
/// The catalog files that a session copies from its default connection
const CATALOG_FILES = ['dashql-catalog-relations.sql', 'dashql-catalog-functions.sql', 'dashql-catalog-changes.sql'];

/// Resolve the aliases of the connections of the app manifest (alias -> connectionId)
function connectionAliases(manifest: Record<string, unknown>): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const entry of Array.isArray(manifest.connections) ? manifest.connections as unknown[] : []) {
        const { id, aliases: entryAliases } = (entry ?? {}) as { id?: unknown; aliases?: unknown };
        if (typeof id !== 'string' || !Array.isArray(entryAliases)) continue;
        for (const alias of entryAliases) {
            if (typeof alias === 'string') aliases.set(alias, id);
        }
    }
    return aliases;
}

/// Sessions keep a copy of the catalog of their default connection up to storage version 3. The step
/// seeds a connection that has no catalog from the copy of the first session that uses it.
///
/// A connection that has a catalog keeps it, the copies are removed by the session format version 7.
/// The catalog is a cache: a native session folder that isn't reachable now loses its copy, the
/// connection describes its catalog when it comes online.
export const sessionCatalogsToConnections: StorageMigrationStep = {
    version: 4,
    description: 'Seed the catalogs of the connections from the catalog copies of the sessions',
    async migrate({ root, logger }) {
        const manifest = await readManifestJson(root);
        if (manifest == null) {
            return;
        }
        const aliases = connectionAliases(manifest);
        let seeded = 0;
        for (const { sessionId, folder } of await listSessionFolders(root, manifest)) {
            try {
                await migrateSessionFolder(folder, SESSION_FORMAT_VERSION);
                const text = await folder.readText('dashql-session.json');
                const data = text == null ? null : JSON.parse(text) as Record<string, unknown>;
                const defaultConnectionId = data?.formatVersion === SESSION_FORMAT_VERSION ? data.defaultConnectionId : null;
                if (typeof defaultConnectionId !== 'string') continue;
                const connectionId = aliases.get(defaultConnectionId) ?? defaultConnectionId;

                const copies: Array<[string, string]> = [];
                for (const name of CATALOG_FILES) {
                    const copy = await folder.readText(name);
                    if (copy != null) copies.push([name, copy]);
                }
                if (copies.length === 0) continue;
                const connection = new OPFSFolder(await (await root.getDirectoryHandle('connections', { create: true }))
                    .getDirectoryHandle(connectionId, { create: true }));
                let hasCatalog = false;
                for (const name of CATALOG_FILES) {
                    hasCatalog = hasCatalog || await connection.exists(name);
                }
                if (hasCatalog) continue;
                for (const [name, copy] of copies) {
                    await connection.writeText(name, copy);
                }
                ++seeded;
            } catch (error) {
                // The catalog is a cache, the next refresh describes the relations anyway
                logger.warn('Failed to seed the catalog of a connection', { sessionId, error: stringifyError(error) }, LOG_CTX);
            }
        }
        logger.info('Seeded the catalogs of connections', { connections: seeded.toString() }, LOG_CTX);
    },
};
