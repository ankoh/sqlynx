import * as React from 'react';

import { AIClient } from '../../platform/ai/ai_client.js';
import {
    AIModelChoice,
    AIModelsSettings,
    AITask,
    readAIModelsSettings,
    resolveAIModelChoice,
    resolveExternalAIModel,
} from '../../platform/ai/ai_models.js';
import type { AITaskClients } from '../../platform/ai/ai_task_clients.js';
import { BundledEmbedClient } from '../../atlas/index/bundled_embed_client.js';
import { DEFAULT_MODEL_BASE_URL } from '../../atlas/index/model.js';
import { useAppConfig } from './app_config.js';
import { useHttpClient } from '../../platform/http/http_client_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { OPFSStorageBackend } from '../notebook/persistence/opfs_storage_backend.js';
import type { StorageBackend } from '../notebook/persistence/storage_backend.js';

const LOG_CTX = 'ai_models';

/// The AI models are stored in the app manifest, next to the app settings
export type AIModelsBackend = Pick<StorageBackend, 'loadAIModels' | 'saveAIModels'>;

/// Pages without a StorageProvider (e.g. the atlas) read the manifest from OPFS directly
async function openManifestBackend(): Promise<AIModelsBackend> {
    const backend = new OPFSStorageBackend();
    await backend.initialize();
    return backend;
}

type ReconfigureFn = (mapper: (settings: AIModelsSettings) => AIModelsSettings) => void;

const SETTINGS_CTX = React.createContext<AIModelsSettings | null>(null);
const RECONFIGURE_CTX = React.createContext<ReconfigureFn | null>(null);
const TASK_CLIENTS_CTX = React.createContext<{ [T in AITask]: AITaskClients[T] | null } | null>(null);

/// The stored AI settings, null while they are loading
export const useAIModels = (): AIModelsSettings | null => React.useContext(SETTINGS_CTX);
export const useAIModelsReconfigure = (): ReconfigureFn => React.useContext(RECONFIGURE_CTX)!;
/// The client of the model that a task runs on, the bundled or the external one. Null if that model cannot run the
/// task: the bundled model only embeds.
export const useAIClientForTask = <T extends AITask>(task: T): AITaskClients[T] | null => React.useContext(TASK_CLIENTS_CTX)?.[task] ?? null;

type Props = {
    /// The backend that holds the manifest, opens the OPFS manifest if not given
    backend?: AIModelsBackend;
    children: React.ReactElement;
};

/// Loads the AI settings from the manifest, persists changes and provides the client of every task
export const AIModelsProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const httpClient = useHttpClient();
    const appConfig = useAppConfig();
    const backend = React.useMemo(
        () => props.backend != null ? Promise.resolve(props.backend) : openManifestBackend(),
        [props.backend],
    );
    const [settings, setSettings] = React.useState<AIModelsSettings | null>(null);
    const changed = React.useRef(false);

    React.useEffect(() => {
        backend.then(b => b.loadAIModels()).then(stored => {
            if (stored != null) logger.info('Loaded AI settings from manifest', {}, LOG_CTX);
            setSettings(s => s ?? readAIModelsSettings(stored));
        }).catch(e => {
            logger.warn('Failed to load AI settings from manifest', { error: String(e) }, LOG_CTX);
            setSettings(s => s ?? {});
        });
    }, [backend, logger]);

    const reconfigure = React.useCallback<ReconfigureFn>(mapper => {
        changed.current = true;
        setSettings(s => mapper(s ?? {}));
    }, []);

    React.useEffect(() => {
        if (!changed.current || settings == null) return;
        const handle = setTimeout(() => {
            backend.then(b => b.saveAIModels(settings)).catch(e => {
                logger.warn('Failed to persist AI settings', { error: String(e) }, LOG_CTX);
            });
        }, 250);
        return () => clearTimeout(handle);
    }, [settings, backend, logger]);

    // Only recreate the client when the resolved config changes
    const external = resolveExternalAIModel(settings);
    const externalKey = JSON.stringify(external);
    const externalClient = React.useMemo(
        () => httpClient == null ? null : new AIClient(logger, httpClient, external),
        [logger, httpClient, externalKey],
    );

    // The bundled model is only loaded when a task embeds with it
    const modelBaseUrl = appConfig?.atlas?.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL;
    const bundledEmbedClient = React.useMemo(() => new BundledEmbedClient(modelBaseUrl), [modelBaseUrl]);
    React.useEffect(() => () => bundledEmbedClient.dispose(), [bundledEmbedClient]);

    const describeChoice = resolveAIModelChoice(AITask.Describe, settings);
    const embedChoice = resolveAIModelChoice(AITask.Embed, settings);
    const taskClients = React.useMemo(() => ({
        // The bundled model only embeds, see bundledModelRunsTask
        [AITask.Describe]: describeChoice === AIModelChoice.Bundled ? null : externalClient,
        [AITask.Embed]: embedChoice === AIModelChoice.Bundled ? bundledEmbedClient : externalClient,
    }), [externalClient, bundledEmbedClient, describeChoice, embedChoice]);

    return (
        <SETTINGS_CTX.Provider value={settings}>
            <RECONFIGURE_CTX.Provider value={reconfigure}>
                <TASK_CLIENTS_CTX.Provider value={taskClients}>{props.children}</TASK_CLIENTS_CTX.Provider>
            </RECONFIGURE_CTX.Provider>
        </SETTINGS_CTX.Provider>
    );
};
