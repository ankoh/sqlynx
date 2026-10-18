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
import { ShellNavBar } from '../shell/shell_navbar.js';
import { ShellConnectionProvider } from '../shell/shell_connection.js';
import { ShellComputeQueryExecutionProvider } from '../shell/computation_query_execution.js';
import { ComputationRegistry } from '../compute/computation_registry.js';
import { ComputationScheduler } from '../compute/computation_scheduler.js';
import { AttachedDatabaseRegistry } from '../app/notebook/connections/attached_database_registry.js';
import { DashQLCoreProvider } from '../app/providers/core_provider.js';
import { AppConfigProvider } from '../app/config/app_config.js';
import { PlatformEventListenerProvider } from '../platform/events/event_listener_provider.js';
import { HttpClientProvider } from '../platform/http/http_client_provider.js';
import { AtlasPage } from './atlas_page.js';
import * as styles from './atlas.module.css';

import '../../static/fonts/fonts.css';
import '../styles/colors.css';
import '../styles/globals.css';

export const ATLAS_DATABASE_ID = 'atlas';

/// Same provider tree as the shell (including the router that the platform event listener needs). The computation
/// registry holds the rows of the index files as data frames, their histograms and cross-filters.
export const Atlas: React.FC = () => {
    const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
    const [generation, setGeneration] = React.useState(0);
    const reset = () => {
        setEngineVersion(null);
        setGeneration(g => g + 1);
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
                                                                <ShellConnectionProvider
                                                                    key={generation}
                                                                    databaseId={ATLAS_DATABASE_ID}
                                                                    notebookId={ATLAS_DATABASE_ID}
                                                                >
                                                                    <ShellComputeQueryExecutionProvider>
                                                                        <ComputationScheduler />
                                                                        <div className={styles.root}>
                                                                            <ShellNavBar
                                                                                engineVersion={engineVersion}
                                                                                onReset={reset}
                                                                                brandSymbol="dashql"
                                                                                brandLabel="Reset atlas"
                                                                                brandTitle="Atlas"
                                                                            />
                                                                            <AtlasPage onEngineVersion={setEngineVersion} />
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
createRoot(element!).render(<Atlas />);
