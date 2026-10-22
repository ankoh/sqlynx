import { renameFileIfPresent } from '../migration_folder.js';
import type { SessionMigrationStep } from '../session_migration.js';

/// The metadata fields that named the session a notebook
const RENAMED_FIELDS: Record<string, string> = {
    notebookId: 'sessionId',
    notebookPath: 'sessionPath',
};

/// Notebooks are called sessions, the files and the identity of the metadata follow
export const notebooksToSessions: SessionMigrationStep = {
    version: 4,
    description: 'Rename notebooks as sessions',
    async migrate(folder) {
        await renameFileIfPresent(folder, 'dashql-notebook.json', 'dashql-session.json');
        await renameFileIfPresent(folder, 'dashql-notebook-index.json', 'dashql-session-index.json');
        const text = await folder.readText('dashql-session.json');
        if (text == null) {
            return;
        }
        const data = JSON.parse(text) as Record<string, unknown>;
        if (!Object.keys(data).some(key => key in RENAMED_FIELDS)) {
            return;
        }
        const renamed = Object.fromEntries(Object.entries(data).map(([key, value]) => [RENAMED_FIELDS[key] ?? key, value]));
        await folder.writeText('dashql-session.json', JSON.stringify(renamed, null, 2));
    },
};
