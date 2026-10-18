import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { AIClient } from '../../platform/ai/ai_client.js';
import { AIModelChoice, AITask, DEFAULT_EXTERNAL_AI_MODEL } from '../../platform/ai/ai_models.js';
import { BundledEmbedClient } from '../../atlas/index/bundled_embed_client.js';
import { HttpClientProvider } from '../../platform/http/http_client_provider.js';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';
import type { AIModels } from '../notebook/persistence/storage_backend.js';
import { AIModelsProvider, useAIClientForTask, useAIModels, useAIModelsReconfigure } from './ai_models_provider.js';

describe('AIModelsProvider', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    async function renderProvider(stored: AIModels | null) {
        const backend = {
            loadAIModels: vi.fn(async () => stored),
            saveAIModels: vi.fn(async (_models: AIModels) => {}),
        };
        const probe: {
            describe: ReturnType<typeof useAIClientForTask<AITask.Describe>>;
            embed: ReturnType<typeof useAIClientForTask<AITask.Embed>>;
            settings: ReturnType<typeof useAIModels>;
            reconfigure: ReturnType<typeof useAIModelsReconfigure> | null;
        } = { describe: null, embed: null, settings: null, reconfigure: null };
        const Probe = () => {
            probe.describe = useAIClientForTask(AITask.Describe);
            probe.embed = useAIClientForTask(AITask.Embed);
            probe.settings = useAIModels();
            probe.reconfigure = useAIModelsReconfigure();
            return null;
        };
        await act(async () => root.render(
            <LoggerProvider>
                <HttpClientProvider>
                    <AIModelsProvider backend={backend}>
                        <Probe />
                    </AIModelsProvider>
                </HttpClientProvider>
            </LoggerProvider>
        ));
        await vi.waitFor(() => expect(probe.settings).not.toBeNull());
        return { backend, probe };
    }

    it('describes with the external model and embeds with the bundled one by default', async () => {
        const { probe } = await renderProvider(null);
        expect(probe.describe).toBeInstanceOf(AIClient);
        expect(probe.embed).toBeInstanceOf(BundledEmbedClient);
    });

    it('embeds with the external model when the task says so', async () => {
        const { probe } = await renderProvider({
            config: { external: { endpointUrl: 'https://example.com', model: 'fast' } },
            tasks: { embed: 'external' },
        });
        expect(probe.embed).toBeInstanceOf(AIClient);
        expect(probe.embed).toBe(probe.describe);
        expect((probe.embed as AIClient).config).toEqual({ endpointUrl: 'https://example.com', model: 'fast', headers: DEFAULT_EXTERNAL_AI_MODEL.headers });
    });

    it('has no describe client when describing with the bundled model, it only embeds', async () => {
        const { probe } = await renderProvider({ tasks: { describe: 'bundled' } });
        expect(probe.describe).toBeNull();
        expect(probe.embed).toBeInstanceOf(BundledEmbedClient);
    });

    it('persists a changed task choice to the manifest', async () => {
        const { backend, probe } = await renderProvider(null);
        expect(backend.saveAIModels).not.toHaveBeenCalled();
        await act(async () => probe.reconfigure!(s => ({ ...s, tasks: { ...s.tasks, embed: AIModelChoice.External } })));
        expect(probe.embed).toBeInstanceOf(AIClient);
        await vi.waitFor(() => expect(backend.saveAIModels).toHaveBeenCalledWith({ tasks: { embed: 'external' } }));
    });
});
