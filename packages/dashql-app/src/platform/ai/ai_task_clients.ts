import { AITask } from './ai_models.js';

export interface AIChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/// A model that writes text
export interface AIDescribeClient {
    complete(messages: AIChatMessage[], signal: AbortSignal): Promise<string>;
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
