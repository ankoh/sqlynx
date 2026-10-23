import JSZip from 'jszip';

import * as app_event from '@ankoh/dashql-jsonschema/app_event.js';

import type { StorageBackend, SessionData, ScriptData, DataFileData, ConnectionParams } from '../../storage/storage_backend.js';
import {
    STORAGE_SESSION_FILE,
    STORAGE_ATTACHMENTS_FOLDER,
    validateDataFileName,
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from '../../storage/storage_backend.js';
import { BASE64URL_CODEC } from '../../../utils/base64.js';
import { sanitizeConnectionParamsForSharing } from '../../connections/connection_params.js';
import { readSessionBundle, regenerateSessionConnectionIds, rebaseSessionAttachmentPaths } from '../../storage/session_bundle.js';

/// The target platform a shared session link points at.
export enum SessionLinkTarget {
    NATIVE,
    WEB
}

/// Options controlling how a session is exported to a ZIP.
export interface SessionExportOptions {
    /// Include the persisted relation and function catalog SQL files when they exist.
    withCatalog?: boolean;
    /// Transform the session metadata after it is loaded from the backend and before it is written
    /// into the ZIP. Scripts are exported verbatim from disk; only the `dashql-session.json`
    /// payload passes through here. The sharing path uses this to sanitize
    /// connection secrets, strip the login hint, or override the name.
    /// Receives the session as stored; returns the session to serialize.
    transformSession?: (session: SessionData) => SessionData;
}

/// Options applied after sanitizing session connection parameters for sharing.
export interface SharedSessionExportOptions {
    /// Carry the sharer's resolved account username in the shared connection identity.
    withLoginHint?: boolean;
    /// Include persisted relation and function catalog SQL files when present.
    withCatalog?: boolean;
    /// Keep the session and connection UUIDs instead of generating export-only identities.
    preserveUUIDs?: boolean;
}

type SharedSessionExportOptionsInput = SharedSessionExportOptions | boolean;

/// Creates a ZIP file from session data and script folders
export async function createSessionZip(
    sessionData: SessionData,
    scripts: ScriptData[],
    schemaSql: string | null = null,
    functionsSql: string | null = null,
    data: readonly DataFileData[] = [],
): Promise<Blob> {
    const zip = new JSZip();

    // Add session metadata
    zip.file(STORAGE_SESSION_FILE, JSON.stringify({
        ...sessionData,
        connections: sessionData.connections.map(connection => ({
            connectionId: connection.connectionId,
            params: sanitizeConnectionParamsForSharing(connection.params),
        })),
    }, null, 2));
    if (schemaSql != null) {
        zip.file(STORAGE_CATALOG_RELATIONS, schemaSql);
    }
    if (functionsSql != null) {
        zip.file(STORAGE_CATALOG_FUNCTIONS, functionsSql);
    }

    // Add the flat ordered scripts.
    const scriptsFolder = zip.folder(STORAGE_SCRIPTS_FOLDER);
    if (!scriptsFolder) {
        throw new Error('Failed to create scripts folder in ZIP');
    }

    for (const script of scripts) {
        if (script.name.toLowerCase() === 'dashql-draft.sql') continue;
        scriptsFolder.file(script.name, script.sql);
    }
    for (const file of data) {
        validateDataFileName(file.name);
        zip.file(`${STORAGE_ATTACHMENTS_FOLDER}/${file.name}`, file.bytes);
    }

    // Generate ZIP blob with compression
    return await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
}

/// Exports a session as a ZIP file by loading from storage backend.
///
/// Scripts are always exported exactly as they exist on disk. Pass `options.transformSession` to
/// adjust the session metadata on the way out (e.g. sanitize connection secrets or drop the login
/// hint when sharing).
export async function exportSessionAsZip(
    sessionId: string,
    backend: StorageBackend,
    options: SessionExportOptions = {}
): Promise<Blob> {
    const bundle = await readSessionBundle(sessionId, backend, options.withCatalog ?? false);

    // Apply the caller's session transform (sharing sanitization, name override, ...)
    const outSession = options.transformSession ? options.transformSession(bundle.session) : bundle.session;
    const scripts = bundle.scripts.map(script => ({
        ...script,
        sql: rebaseSessionAttachmentPaths(script.sql, bundle.session.sessionId, outSession.sessionId)!,
    }));

    // Create ZIP from loaded data
    return await createSessionZip(
        outSession,
        scripts,
        rebaseSessionAttachmentPaths(bundle.schemaSql, bundle.session.sessionId, outSession.sessionId),
        rebaseSessionAttachmentPaths(bundle.functionsSql, bundle.session.sessionId, outSession.sessionId),
        bundle.data,
    );
}

/// Export a session as a shareable ZIP.
///
/// Scripts and the session name are read straight from disk (via `exportSessionAsZip`). Connection
/// params are replaced with their live values and sanitized. By default the exported session and
/// connections receive fresh UUIDs so importing a copy cannot collide with existing runtime state.
export async function exportSessionAsSharedZip(
    backend: StorageBackend,
    sessionId: string,
    connectionParams: ReadonlyMap<string, ConnectionParams>,
    optionsInput: SharedSessionExportOptionsInput = {},
): Promise<Blob> {
    const options = typeof optionsInput === 'boolean' ? { withLoginHint: optionsInput } : optionsInput;
    const withLoginHint = options.withLoginHint ?? true;
    return await exportSessionAsZip(sessionId, backend, {
        withCatalog: options.withCatalog ?? true,
        transformSession: (session: SessionData): SessionData => {
            const sanitized: SessionData = {
                ...session,
                connections: session.connections.map(connection => ({
                    ...connection,
                    params: sanitizeConnectionParamsForSharing(
                        connectionParams.get(connection.connectionId) ?? connection.params,
                        withLoginHint,
                    ),
                })),
            };
            return options.preserveUUIDs
                ? sanitized
                : regenerateSessionConnectionIds({ ...sanitized, sessionId: crypto.randomUUID() });
        },
    });
}

/// Export a session as a shareable link that carries the session ZIP inline.
export async function exportSessionAsUrl(
    backend: StorageBackend,
    sessionId: string,
    connectionParams: any,
    target: SessionLinkTarget,
    optionsInput: SharedSessionExportOptionsInput = {},
): Promise<URL> {
    const options = typeof optionsInput === 'boolean' ? { withLoginHint: optionsInput } : optionsInput;
    const zipBlob = await exportSessionAsSharedZip(
        backend,
        sessionId,
        connectionParams,
        { ...options, withCatalog: options.withCatalog ?? false },
    );
    const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());

    // Wrap the zip in AppEventData - convert to base64 string as required by JSON schema
    const eventData: app_event.AppEventData = {
        session: BASE64URL_CODEC.encode(zipBytes.buffer)
    };

    // Encode the JSON to base64
    const eventDataJson = JSON.stringify(eventData);
    const eventDataBytes = new TextEncoder().encode(eventDataJson);
    const eventDataBase64 = BASE64URL_CODEC.encode(eventDataBytes.buffer);

    switch (target) {
        case SessionLinkTarget.WEB:
            return new URL(`${process.env.DASHQL_APP_URL!}?data=${eventDataBase64}`);
        case SessionLinkTarget.NATIVE:
            return new URL(`dashql://localhost?data=${eventDataBase64}`);
    }
}
