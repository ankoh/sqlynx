import { connectionParamsShareEqual, type ConnectionParams } from '../connections/connection_params.js';
import type { AttachedDatabaseRole } from '../connections/attached_database_registry.js';
import type { ConnectionEntry, NotebookData } from './storage_backend.js';
import { dedupeAttachedDatabases } from './storage_writer.js';

/// A connection that a notebook brings along
export interface ImportedConnectionRef {
    /// The id of the connection in the notebook
    databaseId: string;
    /// The params of the connection in the notebook, shared notebooks carry them without secrets
    params: ConnectionParams;
    /// How the notebook uses the connection
    role: AttachedDatabaseRole;
}

/// How an imported connection relates to the connections of the app
export type ConnectionImportDecision =
    /// The connection is unknown, it is registered as a new connection
    | { kind: 'register' }
    /// The connection is known and describes the same database, the notebook uses it
    | { kind: 'link'; connectionId: string }
    /// Connections of the app may describe the same database, the user decides
    | { kind: 'ask'; candidates: ConnectionEntry[] };

/// The decision for a connection of an imported notebook
export interface ConnectionImportPlanItem {
    /// The connection of the notebook
    ref: ImportedConnectionRef;
    /// The decision
    decision: ConnectionImportDecision;
}

/// What the user chose for a connection that may consolidate with an existing one
export type ConnectionImportChoice =
    /// Use an existing connection
    | { kind: 'link'; connectionId: string }
    /// Keep the connection of the notebook as a connection of its own
    | { kind: 'separate' };

/// Find the entry that a connection id resolves to, aliases included
function findEntry(entries: readonly ConnectionEntry[], connectionId: string): ConnectionEntry | null {
    return entries.find(entry => entry.id === connectionId || (entry.aliases ?? []).includes(connectionId)) ?? null;
}

/// Decide how the connections of an imported notebook map to the connections of the app.
///
/// A notebook that comes back with the id of a known connection and the same params (ignoring
/// secrets, sharing strips them) simply uses the known connection. Every other connection that
/// describes the same database, or shares the id but not the params, is a candidate for
/// consolidation that the user decides on. Exports usually regenerate the ids, so the candidates are
/// found by params.
export function planConnectionImport(notebook: NotebookData, entries: readonly ConnectionEntry[]): ConnectionImportPlanItem[] {
    const refs: ImportedConnectionRef[] = [
        { ...notebook.mainDatabase, role: 'main' },
        ...notebook.attachedDatabases.map(database => ({ ...database, role: 'attached' as const })),
    ];
    return refs.map(ref => {
        const sameId = findEntry(entries, ref.databaseId);
        if (sameId != null && connectionParamsShareEqual(sameId.params, ref.params)) {
            return { ref, decision: { kind: 'link', connectionId: sameId.id } };
        }
        const candidates = [
            ...(sameId == null ? [] : [sameId]),
            ...entries.filter(entry => entry !== sameId && connectionParamsShareEqual(entry.params, ref.params)),
        ];
        if (candidates.length === 0) {
            return { ref, decision: { kind: 'register' } };
        }
        return { ref, decision: { kind: 'ask', candidates } };
    });
}

/// The plan items that need a decision of the user
export function connectionImportQuestions(plan: readonly ConnectionImportPlanItem[]): ConnectionImportPlanItem[] {
    return plan.filter(item => item.decision.kind === 'ask');
}

/// Rewrite the connection references of an imported notebook.
///
/// Linked references take the id and the full params of the app's connection, the notebook then
/// carries the secrets the same way every other copy does. Separate connections keep their id unless
/// the app already uses it for another connection. Unanswered questions keep the connection separate.
export function applyConnectionImportPlan(
    notebook: NotebookData,
    plan: readonly ConnectionImportPlanItem[],
    choices: ReadonlyMap<string, ConnectionImportChoice>,
    entries: readonly ConnectionEntry[],
    randomUUID: () => string = () => crypto.randomUUID(),
): NotebookData {
    const byRef = new Map(plan.map(item => [item.ref.databaseId, item]));
    const freshIds = new Map<string, string>();
    const rewrite = (database: NotebookData['mainDatabase']): NotebookData['mainDatabase'] => {
        const item = byRef.get(database.databaseId);
        let link: string | null = null;
        if (item?.decision.kind === 'link') {
            link = item.decision.connectionId;
        } else if (item?.decision.kind === 'ask') {
            const choice = choices.get(database.databaseId);
            if (choice?.kind === 'link') link = choice.connectionId;
        }
        if (link != null) {
            const entry = entries.find(e => e.id === link);
            if (entry != null) return { databaseId: entry.id, params: entry.params };
        }
        // A separate connection must not take over the id of an existing one
        if (findEntry(entries, database.databaseId) == null) {
            return { databaseId: database.databaseId, params: database.params };
        }
        let freshId = freshIds.get(database.databaseId);
        if (freshId == null) {
            freshId = randomUUID();
            freshIds.set(database.databaseId, freshId);
        }
        return { databaseId: freshId, params: database.params };
    };
    const mainDatabase = rewrite(notebook.mainDatabase);
    return {
        ...notebook,
        mainDatabase,
        attachedDatabases: dedupeAttachedDatabases(mainDatabase.databaseId, notebook.attachedDatabases.map(rewrite)),
    };
}

/// Did resolving the connections change the references of the notebook?
export function connectionRefsChanged(before: NotebookData, after: NotebookData): boolean {
    const refs = (notebook: NotebookData) => JSON.stringify([
        notebook.mainDatabase.databaseId,
        notebook.mainDatabase.params,
        ...notebook.attachedDatabases.flatMap(database => [database.databaseId, database.params]),
    ]);
    return refs(before) !== refs(after);
}
