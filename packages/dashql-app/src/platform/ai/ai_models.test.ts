import { describe, expect, it } from 'vitest';

import {
    AIModelChoice,
    AITask,
    DEFAULT_EXTERNAL_AI_MODEL,
    readAIModelsSettings,
    resolveAIModelChoice,
    resolveExternalAIModel,
} from './ai_models.js';

describe('resolveAIModelChoice', () => {
    it('embeds with the bundled model and describes with the external one by default', () => {
        expect(resolveAIModelChoice(AITask.Embed, null)).toBe(AIModelChoice.Bundled);
        expect(resolveAIModelChoice(AITask.Describe, {})).toBe(AIModelChoice.External);
    });

    it('follows the stored choice', () => {
        expect(resolveAIModelChoice(AITask.Embed, { tasks: { embed: AIModelChoice.External } })).toBe(AIModelChoice.External);
        expect(resolveAIModelChoice(AITask.Describe, { tasks: { describe: AIModelChoice.Bundled } })).toBe(AIModelChoice.Bundled);
    });
});

describe('resolveExternalAIModel', () => {
    it('fills in the defaults', () => {
        expect(resolveExternalAIModel(null)).toEqual(DEFAULT_EXTERNAL_AI_MODEL);
        expect(resolveExternalAIModel({ config: { external: { model: 'smart' } } })).toEqual({ ...DEFAULT_EXTERNAL_AI_MODEL, model: 'smart' });
    });

    it('drops unnamed headers', () => {
        expect(resolveExternalAIModel({
            config: {
                external: {
                    endpointUrl: 'https://example.com',
                    model: 'smart',
                    headers: [{ name: 'Authorization', value: 'Bearer token' }, { name: ' ', value: 'x' }],
                },
            },
        })).toEqual({
            endpointUrl: 'https://example.com',
            model: 'smart',
            headers: [{ name: 'Authorization', value: 'Bearer token' }],
        });
    });
});

describe('readAIModelsSettings', () => {
    it('keeps valid fields and drops the rest', () => {
        expect(readAIModelsSettings({
            config: {
                external: { endpointUrl: 'https://example.com', model: 42, headers: [{ name: 'a', value: 'b' }, { name: 'c' }] },
            },
            tasks: { embed: 'external', describe: 'nope', other: 'bundled' },
            embedder: 'bundled',
        })).toEqual({
            config: { external: { endpointUrl: 'https://example.com', headers: [{ name: 'a', value: 'b' }] } },
            tasks: { embed: AIModelChoice.External },
        });
        expect(readAIModelsSettings(null)).toEqual({});
        expect(readAIModelsSettings([1])).toEqual({});
        expect(readAIModelsSettings({ tasks: [] })).toEqual({});
    });
});
