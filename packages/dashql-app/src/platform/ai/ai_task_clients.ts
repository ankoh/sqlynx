import { AITask } from './ai_models.js';

export interface AIChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface AICompletionOptions {
    /// Ask for a JSON object that matches a JSON schema. Endpoints that do not support it may answer with free text.
    jsonSchema?: { name: string; schema: object };
}

export interface AICompletion {
    content: string;
    /// The token counts, if the endpoint reports them
    promptTokens: number | null;
    completionTokens: number | null;
    finishReason: string | null;
}

/// A model that writes text
export interface AIDescribeClient {
    /// The id of the model, for the logs
    readonly model: string;
    complete(messages: AIChatMessage[], signal: AbortSignal, options?: AICompletionOptions): Promise<AICompletion>;
}

/// A model that embeds texts. Documents and queries are embedded separately, some models prefix them differently.
export interface AIEmbedClient {
    embedDocuments(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
    embedQuery(text: string, signal: AbortSignal): Promise<Float32Array>;
}

/// The client of every task
export interface AITaskClients {
    [AITask.Describe]: AIDescribeClient;
    [AITask.Embed]: AIEmbedClient;
}
