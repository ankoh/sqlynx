import { connectionParamsShareEqual, type ConnectionParams } from '../../connections/connection_params.js';
import type { ConnectionEntry, SessionConnection, SessionData } from '../../storage/storage_backend.js';
import { dedupeConnections } from '../../storage/storage_writer.js';

/// How a session uses a connection, as its default connection or for some of its scripts
export type SessionConnectionRole = 'main' | 'attached';

/// A connection that a session brings along
export interface ImportedConnectionRef {
    /// The id of the connection in the session
    connectionId: string;
    /// The display name of the connection in the session, absent when it is unnamed
    name?: string;
    /// The params of the connection in the session, shared sessions carry them without secrets
    params: ConnectionParams;
    /// How the session uses the connection
    role: SessionConnectionRole;
}

/// How an imported connection relates to the connections of the app
export type ConnectionImportDecision =
    /// The connection is unknown, it is registered as a new connection
    | { kind: 'register' }
    /// The connection is known and describes the same database, the session uses it
    | { kind: 'link'; connectionId: string }
    /// Connections of the app may describe the same database, the user decides
    | { kind: 'ask'; candidates: ConnectionEntry[] };

/// The decision for a connection of an imported session
export interface ConnectionImportPlanItem {
    /// The connection of the session
    ref: ImportedConnectionRef;
    /// The decision
    decision: ConnectionImportDecision;
}

/// What the user chose for a connection that may consolidate with an existing one
export type ConnectionImportChoice =
    /// Use an existing connection
    | { kind: 'link'; connectionId: string }
    /// Keep the connection of the session as a connection of its own
    | { kind: 'separate' };

/// Find the entry that a connection id resolves to, aliases included
function findEntry(entries: readonly ConnectionEntry[], connectionId: string): ConnectionEntry | null {
    return entries.find(entry => entry.id === connectionId || (entry.aliases ?? []).includes(connectionId)) ?? null;
}

/// Decide how the connections of an imported session map to the connections of the app.
///
/// A session that comes back with the id of a known connection and the same params (ignoring
/// secrets, sharing strips them) simply uses the known connection. Every other connection that
/// describes the same database, or shares the id but not the params, is a candidate for
/// consolidation that the user decides on. Exports usually regenerate the ids, so the candidates are
/// found by params.
export function planConnectionImport(session: SessionData, entries: readonly ConnectionEntry[]): ConnectionImportPlanItem[] {
    const refs: ImportedConnectionRef[] = session.connections.map(connection => ({
        connectionId: connection.connectionId,
        ...(connection.name == null ? {} : { name: connection.name }),
        params: connection.params,
        role: connection.connectionId === session.defaultConnectionId ? 'main' : 'attached',
    }));
    return refs.map(ref => {
        const sameId = findEntry(entries, ref.connectionId);
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

/// Rewrite the connection references of an imported session.
///
/// Linked references take the id and the full params of the app's connection, the session then
/// carries the secrets the same way every other copy does. Separate connections keep their id unless
/// the app already uses it for another connection. Unanswered questions keep the connection separate.
export function applyConnectionImportPlan(
    session: SessionData,
    plan: readonly ConnectionImportPlanItem[],
    choices: ReadonlyMap<string, ConnectionImportChoice>,
    entries: readonly ConnectionEntry[],
    randomUUID: () => string = () => crypto.randomUUID(),
): SessionData {
    const byRef = new Map(plan.map(item => [item.ref.connectionId, item]));
    const freshIds = new Map<string, string>();
    const resolve = (connectionId: string): { connectionId: string; entry: ConnectionEntry | null } => {
        const item = byRef.get(connectionId);
        let link: string | null = null;
        if (item?.decision.kind === 'link') {
            link = item.decision.connectionId;
        } else if (item?.decision.kind === 'ask') {
            const choice = choices.get(connectionId);
            if (choice?.kind === 'link') link = choice.connectionId;
        }
        if (link != null) {
            const entry = entries.find(e => e.id === link);
            if (entry != null) return { connectionId: entry.id, entry };
        }
        // A separate connection must not take over the id of an existing one
        if (findEntry(entries, connectionId) == null) {
            return { connectionId, entry: null };
        }
        let freshId = freshIds.get(connectionId);
        if (freshId == null) {
            freshId = randomUUID();
            freshIds.set(connectionId, freshId);
        }
        return { connectionId: freshId, entry: null };
    };
    const rewrite = (connection: SessionConnection): SessionConnection => {
        const resolved = resolve(connection.connectionId);
        const name = resolved.entry != null ? resolved.entry.name : connection.name;
        return {
            connectionId: resolved.connectionId,
            ...(name == null ? {} : { name }),
            params: resolved.entry?.params ?? connection.params,
        };
    };
    // The default connection and the scripts follow their connections
    return {
        ...session,
        defaultConnectionId: resolve(session.defaultConnectionId).connectionId,
        connections: dedupeConnections(session.connections.map(rewrite)),
        scripts: session.scripts.map(script => ({ ...script, connectionId: resolve(script.connectionId).connectionId })),
    };
}

/// Did resolving the connections change the references of the session?
export function connectionRefsChanged(before: SessionData, after: SessionData): boolean {
    const refs = (session: SessionData) => JSON.stringify([
        session.defaultConnectionId,
        ...session.connections.flatMap(connection => [connection.connectionId, connection.params]),
        ...session.scripts.map(script => script.connectionId),
    ]);
    return refs(before) !== refs(after);
}
