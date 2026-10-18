/// The tasks the app uses models for. Describing writes descriptions of scripts and wants a smart model, embedding
/// computes the embeddings of a semantic search and wants a fast one.
export enum AITask {
    Describe = 'describe',
    Embed = 'embed',
}

export const AI_TASKS: AITask[] = [AITask.Describe, AITask.Embed];

/// Every task runs either on the model that is bundled with the app or on the one external model
export enum AIModelChoice {
    Bundled = 'bundled',
    External = 'external',
}

/// The bundled model is an embedding model, it cannot describe
export function bundledModelRunsTask(task: AITask): boolean {
    return task === AITask.Embed;
}

const DEFAULT_CHOICES: Record<AITask, AIModelChoice> = {
    [AITask.Describe]: AIModelChoice.External,
    [AITask.Embed]: AIModelChoice.Bundled,
};

export interface AIModelHeader {
    name: string;
    value: string;
}

/// The stored settings of the external model, unset fields fall back to the defaults
export interface ExternalAIModelSettings {
    endpointUrl?: string;
    model?: string;
    headers?: AIModelHeader[];
}

/// The models that can run tasks, the bundled one needs no configuration
export interface AIModelsConfig {
    external?: ExternalAIModelSettings;
}

/// The model that every task runs on
export type AITaskChoices = Partial<Record<AITask, AIModelChoice>>;

export interface AIModelsSettings {
    config?: AIModelsConfig;
    tasks?: AITaskChoices;
}

/// The settings of the external model with the defaults filled in
export interface AIModelConfig {
    endpointUrl: string;
    model: string;
    headers: AIModelHeader[];
}

export const DEFAULT_EXTERNAL_AI_MODEL: AIModelConfig = {
    endpointUrl: 'http://localhost:11434',
    model: 'llama3',
    headers: [],
};

/// The model that a task runs on
export function resolveAIModelChoice(task: AITask, settings: AIModelsSettings | null): AIModelChoice {
    return settings?.tasks?.[task] ?? DEFAULT_CHOICES[task];
}

/// The settings of the external model with the defaults filled in
export function resolveExternalAIModel(settings: AIModelsSettings | null): AIModelConfig {
    const external = settings?.config?.external;
    return {
        endpointUrl: external?.endpointUrl ?? DEFAULT_EXTERNAL_AI_MODEL.endpointUrl,
        model: external?.model ?? DEFAULT_EXTERNAL_AI_MODEL.model,
        headers: (external?.headers ?? DEFAULT_EXTERNAL_AI_MODEL.headers).filter(h => h.name.trim().length > 0),
    };
}

function readHeader(value: unknown): AIModelHeader | null {
    if (value == null || typeof value !== 'object') return null;
    const header = value as Record<string, unknown>;
    if (typeof header.name !== 'string' || typeof header.value !== 'string') return null;
    return { name: header.name, value: header.value };
}

function readExternalModel(value: unknown): ExternalAIModelSettings | undefined {
    if (value == null || typeof value !== 'object') return undefined;
    const model = value as Record<string, unknown>;
    const settings: ExternalAIModelSettings = {};
    if (typeof model.endpointUrl === 'string') settings.endpointUrl = model.endpointUrl;
    if (typeof model.model === 'string') settings.model = model.model;
    if (Array.isArray(model.headers)) {
        settings.headers = model.headers.map(readHeader).filter((h): h is AIModelHeader => h != null);
    }
    return settings;
}

function readChoice(value: unknown): AIModelChoice | undefined {
    return value === AIModelChoice.Bundled || value === AIModelChoice.External ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> | null {
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/// Read stored settings, fields of the wrong type are dropped
export function readAIModelsSettings(value: unknown): AIModelsSettings {
    const stored = readObject(value);
    if (stored == null) return {};
    const settings: AIModelsSettings = {};
    const config = readObject(stored.config);
    if (config != null) {
        const external = readExternalModel(config.external);
        settings.config = external != null ? { external } : {};
    }
    const tasks = readObject(stored.tasks);
    if (tasks != null) {
        settings.tasks = {};
        for (const task of AI_TASKS) {
            const choice = readChoice(tasks[task]);
            if (choice != null) settings.tasks[task] = choice;
        }
    }
    return settings;
}
