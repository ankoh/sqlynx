import * as React from 'react';
import * as styles from './notebook_shell_page.module.css';

import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { useCancelQuery, useQueryExecutor, useQueryState } from '../connections/query_executor.js';
import { NotebookViewMode, useNotebookViewMode } from '../scripts/notebook_commands.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import {
    DashQLShell,
} from '../../../shell/api.js';
import type { BrowserShellController } from '../../../shell/browser_shell.js';
import { createNotebookShell } from './notebook_shell_catalog.js';
import {
    createNotebookShellEnvironment,
} from './notebook_shell_environment.js';
import { ShellQueryResultOverlay } from './shell_query_result_overlay.js';
import { createShellOutputCommand, type ShellOutputMode } from '../../../shell/shell_result.js';
import { useAppConfig } from '../../config/app_config.js';
import { getKeywordCase } from '../ui/script_format.js';

const LOG_CTX = 'notebook_shell_page';

function formatInstantiationProgress(bytesLoaded: number, bytesTotal: number): string {
    if (bytesTotal <= 0) return `Loading ${Math.round(bytesLoaded / 1000)} kB`;
    const blocks = Math.max(0, Math.min(10, Math.floor(bytesLoaded / bytesTotal * 10)));
    return `Loading [${'#'.repeat(blocks)}${'-'.repeat(10 - blocks)}]`;
}

interface Props {
    notebookId: string;
    notebookName?: string | null;
    connection: AttachedDatabaseState | null;
    active: boolean;
}

export const NotebookShellPage: React.FC<Props> = ({ notebookId, notebookName, connection, active }) => {
    const keywordCase = getKeywordCase(useAppConfig()?.settings);
    const keywordCaseRef = React.useRef(keywordCase);
    keywordCaseRef.current = keywordCase;
    const logger = useLogger();
    const executeQuery = useQueryExecutor();
    const cancelQuery = useCancelQuery();
    const { setMode } = useNotebookViewMode();
    const containerRef = React.useRef<HTMLDivElement>(null);
    const controllerRef = React.useRef<BrowserShellController | null>(null);
    const shellRef = React.useRef<DashQLShell | null>(null);
    React.useEffect(() => {
        shellRef.current?.setKeywordCase(keywordCase);
    }, [keywordCase]);
    const generationRef = React.useRef(0);
    const outputModeRef = React.useRef<ShellOutputMode>('auto');
    const terminalColumnsRef = React.useRef(100);
    const [status, setStatus] = React.useState('Instantiating Shell');
    const [resultQueryId, setResultQueryId] = React.useState<number | null>(null);
    const resultQuery = useQueryState(notebookId, resultQueryId);
    const connectorName = connection?.connectorInfo.names.displayShort ?? '';
    const shellName = `${notebookName ?? connectorName} Shell`;
    const relationsSql = connection?.catalogRelationScript.toString() ?? '';
    const functionsSql = connection?.catalogFunctionScript.toString() ?? '';

    React.useEffect(() => {
        if (connection == null || containerRef.current == null) return;
        const generation = ++generationRef.current;
        let cancelled = false;
        const getOutputMode = () => outputModeRef.current;
        const environment = createNotebookShellEnvironment(
            notebookId,
            connection.databaseId,
            executeQuery,
            cancelQuery,
            getOutputMode,
            () => terminalColumnsRef.current,
        );
        const outputCommand = createShellOutputCommand(getOutputMode, mode => {
            outputModeRef.current = mode;
        });
        setStatus(shellRef.current == null ? 'Instantiating Shell' : 'Refreshing shell catalog');
        void createNotebookShell({ relationsSql, functionsSql }, environment, {
            commands: [outputCommand],
            onProgress: progress => {
                if (!cancelled && generation === generationRef.current) {
                    setStatus(`Instantiating Shell: ${formatInstantiationProgress(progress.bytesLoaded, progress.bytesTotal)}`);
                }
            },
        }).then(async nextShell => {
            nextShell.setKeywordCase(keywordCaseRef.current);
            if (cancelled || generation !== generationRef.current) {
                nextShell.destroy();
                return;
            }
            if (controllerRef.current == null) {
                const { embedDashQLShell } = await import('../../../shell/browser_shell.js');
                if (cancelled || generation !== generationRef.current || containerRef.current == null) {
                    nextShell.destroy();
                    return;
                }
                controllerRef.current = await embedDashQLShell({
                    container: containerRef.current,
                    shell: nextShell,
                    greeter: [shellName, 'Enter .help for usage hints.'],
                    prompt: `${connectorName.toLowerCase()}> `,
                    onExit: () => setMode(NotebookViewMode.Notebook),
                    onQueryResult: setResultQueryId,
                    onTerminalResize: columns => { terminalColumnsRef.current = columns; },
                });
            } else {
                controllerRef.current.replaceShell(nextShell);
                controllerRef.current.writeStatus('Catalog refreshed');
            }
            const previous = shellRef.current;
            shellRef.current = nextShell;
            previous?.destroy();
            setStatus('');
            if (active) controllerRef.current.focus();
        }).catch(error => {
            if (cancelled || generation !== generationRef.current) return;
            const message = `Failed to load shell: ${stringifyError(error)}`;
            logger.warn(message, {}, LOG_CTX);
            controllerRef.current?.writeStatus(message);
            setStatus(message);
        });
        return () => {
            cancelled = true;
        };
    }, [connection?.databaseId, connectorName, shellName, relationsSql, functionsSql, executeQuery, cancelQuery, setMode]);

    React.useEffect(() => {
        if (active) controllerRef.current?.focus();
    }, [active]);

    React.useEffect(() => {
        setResultQueryId(null);
    }, [connection?.databaseId]);

    React.useEffect(() => () => {
        ++generationRef.current;
        controllerRef.current?.dispose();
        controllerRef.current = null;
        shellRef.current?.destroy();
        shellRef.current = null;
    }, []);

    return (
        <main className={styles.page} aria-label={shellName}>
            <div className={styles.terminal}>
                <div ref={containerRef} className={styles.terminalHost} />
            </div>
            {status && (
                <div className={styles.status} role="status" aria-live="polite">
                    <strong>[ RUN ]</strong> {status}
                </div>
            )}
            {resultQuery != null && (
                <ShellQueryResultOverlay query={resultQuery} onClose={() => setResultQueryId(null)} />
            )}
        </main>
    );
};

export default NotebookShellPage;
