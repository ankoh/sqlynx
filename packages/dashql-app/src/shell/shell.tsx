import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { FileDownloaderProvider } from '../platform/file/file_downloader_provider.js';
import { LoggerProvider } from '../platform/logger/logger_provider.js';
import { PlatformTypeProvider } from '../platform/platform_type.js';
import { ProcessProvider } from '../platform/process.js';
import { EmbeddedDatabaseProvider } from '../platform/database/embedded_database_provider.js';
import { GitHubTheme } from '../theme/github_theme.js';
import { LoggerToast } from '../ui/logger/logger_toast.js';
import { ShellNavBar } from './shell_navbar.js';
import { ShellPage } from './shell_page.js';
import { ShellConnectionProvider } from './shell_connection.js';
import { AttachedDatabaseRegistry } from '../app/connections/attached_database_registry.js';
import { ComputationRegistry } from '../compute/computation_registry.js';
import { ComputationScheduler } from '../compute/computation_scheduler.js';
import { DashQLCoreProvider } from '../app/providers/core_provider.js';
import { ShellComputeQueryExecutionProvider } from './computation_query_execution.js';
import { AppConfigProvider } from '../app/config/app_config.js';
import { PlatformEventListenerProvider } from '../platform/events/event_listener_provider.js';
import { HttpClientProvider } from '../platform/http/http_client_provider.js';
import * as styles from './shell.module.css';

import '../../static/fonts/fonts.css';
import '../styles/colors.css';
import '../styles/globals.css';

export const Shell: React.FC = () => {
    const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
    const [shellGeneration, setShellGeneration] = React.useState(0);
    const resetShell = () => {
        setEngineVersion(null);
        setShellGeneration(generation => generation + 1);
    };

    return (
        <BrowserRouter>
            <PlatformTypeProvider>
                <LoggerProvider>
                    <>
                        <LoggerToast />
                        <FileDownloaderProvider>
                            <AppConfigProvider>
                                <PlatformEventListenerProvider>
                                    <HttpClientProvider>
                                        <ProcessProvider>
                                            <EmbeddedDatabaseProvider>
                                                <GitHubTheme>
                                                    <DashQLCoreProvider>
                                                        <ComputationRegistry>
                                                            <AttachedDatabaseRegistry>
                                                                <ShellConnectionProvider key={shellGeneration}>
                                                                    <ShellComputeQueryExecutionProvider>
                                                                        <ComputationScheduler />
                                                                        <div className={styles.root}>
                                                                            <ShellNavBar
                                                                                engineVersion={engineVersion}
                                                                                onReset={resetShell}
                                                                            />
                                                                            <ShellPage onEngineVersion={setEngineVersion} />
                                                                        </div>
                                                                    </ShellComputeQueryExecutionProvider>
                                                                </ShellConnectionProvider>
                                                            </AttachedDatabaseRegistry>
                                                        </ComputationRegistry>
                                                    </DashQLCoreProvider>
                                                </GitHubTheme>
                                            </EmbeddedDatabaseProvider>
                                        </ProcessProvider>
                                    </HttpClientProvider>
                                </PlatformEventListenerProvider>
                            </AppConfigProvider>
                        </FileDownloaderProvider>
                    </>
                </LoggerProvider>
            </PlatformTypeProvider>
        </BrowserRouter>
    );
};

const element = document.getElementById('root');
createRoot(element!).render(<Shell />);
