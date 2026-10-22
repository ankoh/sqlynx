import * as React from 'react';

import type { AIClient } from '../../../platform/ai/ai_client.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import { SET_SCRIPT_TEXT, type SessionScripts, type ScriptData } from '../scripts/session_scripts.js';
import { buildCatalogNameIndex, collectMentionedIdentifiers } from './catalog_name_index.js';
import { buildSchemaContext, describeSqlDialect, findSqlProblems, generateSqlFromPrompt, promptComment } from './sql_generation.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';

const LOG_CTX = 'sql_generations';

/// The translation of a question into the SQL of a script
export interface ScriptGeneration {
    /// Aborts the translation
    controller: AbortController;
    /// The error of a failed translation, null while it runs
    error: string | null;
}

/// A script that was appended to the session
export interface AppendedScript {
    /// The session scripts with the appended script
    next: SessionScripts;
    /// The appended script
    scriptData: ScriptData;
}

/// The session a question is translated in
export interface SqlGenerationsArgs {
    /// The AI provider, null if none is configured
    aiClient: AIClient | null;
    /// The scripts of the session, a deleted script stops its translation
    sessionScripts: SessionScripts;
    /// The connection whose schema the SQL is generated for
    conn: AttachedDatabaseState | null;
    /// Modifies the scripts of the session
    modifySessionScripts: ModifySessionScripts;
    /// Appends a script with the given text to the session
    appendScript: (text: string) => Promise<AppendedScript | null>;
    /// Runs a script once its SQL is generated
    runScript: (next: SessionScripts, scriptData: ScriptData) => void;
    /// Generates the SQL, replaceable in tests
    generateSqlFromPrompt?: typeof generateSqlFromPrompt;
}

/// The translations of questions into SQL in a session
export interface SqlGenerations {
    /// The running and failed translations by script key
    generations: ReadonlyMap<number, ScriptGeneration>;
    /// Translate a question into a new script
    translate: (question: string) => Promise<void>;
    /// Stop the translation of a script
    stop: (scriptKey: number) => void;
    /// Dismiss the error of a failed translation
    dismiss: (scriptKey: number) => void;
}

/// Translate questions into the SQL of new session scripts.
///
/// A question becomes a script with the question as comment right away.
/// The translated SQL is appended once the AI provider answers, then the script runs.
export function useSqlGenerations(args: SqlGenerationsArgs): SqlGenerations {
    const logger = useLogger();
    const latest = React.useRef(args);
    latest.current = args;

    const [generations, setGenerations] = React.useState<ReadonlyMap<number, ScriptGeneration>>(() => new Map());
    const generationsRef = React.useRef(generations);
    generationsRef.current = generations;
    const setGeneration = React.useCallback((scriptKey: number, generation: ScriptGeneration | null) => {
        setGenerations(prev => {
            const next = new Map(prev);
            if (generation == null) next.delete(scriptKey);
            else next.set(scriptKey, generation);
            return next;
        });
    }, []);
    const stop = React.useCallback((scriptKey: number) => {
        const generation = generationsRef.current.get(scriptKey);
        if (generation == null) return;
        generation.controller.abort();
        setGeneration(scriptKey, null);
        logger.info('Stopped translating a question into SQL', { scriptKey: String(scriptKey) }, LOG_CTX);
    }, [logger, setGeneration]);
    const dismiss = React.useCallback((scriptKey: number) => setGeneration(scriptKey, null), [setGeneration]);

    // A deleted script stops its translation, so does unmounting
    React.useEffect(() => {
        for (const [scriptKey, generation] of generationsRef.current) {
            if (args.sessionScripts.scripts[scriptKey] == null) {
                generation.controller.abort();
                setGeneration(scriptKey, null);
                logger.info('Stopped translating a question of a deleted script', { scriptKey: String(scriptKey) }, LOG_CTX);
            }
        }
    }, [args.sessionScripts.scripts, logger, setGeneration]);
    React.useEffect(() => () => {
        for (const generation of generationsRef.current.values()) generation.controller.abort();
    }, []);

    const translate = React.useCallback(async (question: string) => {
        const { aiClient, appendScript } = latest.current;
        if (aiClient == null) {
            logger.error('Cannot translate a question without an AI provider', {}, LOG_CTX);
            return;
        }
        const appended = await appendScript(promptComment(question));
        if (appended == null) return;
        const scriptKey = appended.scriptData.scriptKey;
        const controller = new AbortController();
        setGeneration(scriptKey, { controller, error: null });

        const { sessionScripts, conn } = latest.current;
        const generate = latest.current.generateSqlFromPrompt ?? generateSqlFromPrompt;
        const dialect = describeSqlDialect(sessionScripts.connectorInfo.connectorType);
        logger.info('Translating a question into SQL', { scriptKey: String(scriptKey), characters: String(question.length), dialect }, LOG_CTX);
        let sql: string;
        try {
            sql = await generate(aiClient, {
                prompt: question,
                dialect,
                schema: buildSchemaContext(conn, sessionScripts, logger),
                mentionedIdentifiers: collectMentionedIdentifiers(buildCatalogNameIndex(sessionScripts.connectionCatalog), question),
            }, sql => findSqlProblems(sessionScripts.instance, sessionScripts.connectionCatalog, sql), controller.signal);
        } catch (e: unknown) {
            if (controller.signal.aborted) return;
            logger.error('Translating a question into SQL failed', { scriptKey: String(scriptKey), error: stringifyError(e) }, LOG_CTX);
            setGeneration(scriptKey, { controller, error: stringifyError(e) });
            return;
        }
        if (controller.signal.aborted) return;
        setGeneration(scriptKey, null);
        logger.info('Translated a question into SQL', { scriptKey: String(scriptKey), characters: String(sql.length) }, LOG_CTX);

        // Keep whatever the user wrote into the script meanwhile, the SQL goes below
        const current = latest.current.sessionScripts.scripts[scriptKey];
        if (current == null) return;
        const text = `${current.scriptSession.getText().trimEnd()}\n${sql}`;
        const result = latest.current.modifySessionScripts({ type: SET_SCRIPT_TEXT, value: { scriptKey, text } });
        if (!result) return;
        const next = await result;
        const scriptData = next?.scripts[scriptKey];
        if (next != null && scriptData != null) latest.current.runScript(next, scriptData);
    }, [logger, setGeneration]);

    return { generations, translate, stop, dismiss };
}
