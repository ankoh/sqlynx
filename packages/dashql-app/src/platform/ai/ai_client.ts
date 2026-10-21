import { HttpClient } from "../http/http_client.js";
import { Logger } from "../logger/logger.js";
import { AIProviderAuth, AIProviderHeader } from "../../app/config/app_config.js";

/// Resolved (non-optional) provider settings used by the client.
export interface AIClientSettings {
    endpointUrl: string;
    model: string;
    headers: AIProviderHeader[];
    auth: AIProviderAuth;
}

const LOG_CTX = "ai_client";

/// A message of a chat completion
export interface ChatMessage {
    /// Who wrote the message
    role: "system" | "user" | "assistant";
    /// The text of the message
    content: string;
}

interface ChatCompletionResponse {
    choices?: { message?: { content?: string } }[];
}

interface ListModelsResponse {
    data?: { id?: string }[];
}

/// The verdict of a validation hook on an answer of the model
export type CompletionValidation<T> =
    /// The answer is usable
    | { valid: true; value: T }
    /// The answer is not usable, the feedback tells the model what to fix.
    /// The value is the best effort interpretation of the answer, null if there is none.
    | { valid: false; value: T | null; feedback: string };

function joinUrl(base: string, path: string): URL {
    const trimmed = base.replace(/\/+$/, "");
    return new URL(trimmed + path);
}

/// Base64 of the UTF-8 bytes, btoa alone rejects characters outside of Latin-1
function encodeBase64(text: string): string {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/// The value of the Authorization header, null if the method sends none
export function buildAuthorization(auth: AIProviderAuth): string | null {
    switch (auth.type) {
        case "basic":
            return `Basic ${encodeBase64(`${auth.username ?? ""}:${auth.password ?? ""}`)}`;
        case "bearer":
            return `Bearer ${auth.token ?? ""}`;
        default:
            return null;
    }
}

function buildHeaders(extra: AIProviderHeader[], auth: AIProviderAuth): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    for (const h of extra) {
        if (h.name) headers[h.name] = h.value;
    }
    // The authorization method wins over an Authorization header in the additional headers
    const authorization = buildAuthorization(auth);
    if (authorization != null) {
        for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === "authorization") delete headers[name];
        }
        headers["Authorization"] = authorization;
    }
    return headers;
}

/// An AI client speaking the OpenAI-compatible chat completions REST API.
/// Works with OpenAI, Ollama (/v1/* compat layer), vLLM, llama.cpp, etc.
export class AIClient {
    logger: Logger;
    httpClient: HttpClient;
    settings: AIClientSettings;

    constructor(logger: Logger, httpClient: HttpClient, settings: AIClientSettings) {
        this.logger = logger;
        this.httpClient = httpClient;
        this.settings = settings;
    }

    /// List available models. Used for the Test button in AI settings.
    async listModels(signal: AbortSignal): Promise<string[]> {
        const url = joinUrl(this.settings.endpointUrl, "/v1/models");
        this.logger.debug("Listing AI models", { url: url.toString() }, LOG_CTX);
        const response = await this.httpClient.fetch(url, {
            method: "GET",
            headers: buildHeaders(this.settings.headers, this.settings.auth),
            signal,
        });
        if (response.status < 200 || response.status >= 300) {
            const body = await response.text();
            this.logger.warn("Listing AI models failed", { status: String(response.status), body: body.slice(0, 200) }, LOG_CTX);
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
        }
        const parsed = (await response.json()) as ListModelsResponse;
        const ids: string[] = [];
        for (const m of parsed.data ?? []) {
            if (typeof m.id === "string") ids.push(m.id);
        }
        return ids;
    }

    /// Generate a completion for a single user prompt.
    async generate(prompt: string, signal: AbortSignal): Promise<string> {
        return this.complete([{ role: "user", content: prompt }], signal);
    }

    /// Generate an answer that passes a validation hook.
    /// A rejected answer goes back to the model together with the feedback of the hook until the attempts are used up.
    /// Returns the verdict on the last answer.
    async completeValidated<T>(
        messages: ChatMessage[],
        validate: (content: string) => CompletionValidation<T>,
        signal: AbortSignal,
        maxAttempts: number = 2,
    ): Promise<CompletionValidation<T>> {
        const conversation = [...messages];
        for (let attempt = 1; ; ++attempt) {
            const content = await this.complete(conversation, signal);
            const verdict = validate(content);
            if (verdict.valid) {
                return verdict;
            }
            this.logger.warn("AI answer failed validation", {
                attempt: String(attempt),
                maxAttempts: String(maxAttempts),
                feedback: verdict.feedback,
            }, LOG_CTX);
            if (attempt >= maxAttempts) {
                return verdict;
            }
            conversation.push({ role: "assistant", content }, { role: "user", content: verdict.feedback });
        }
    }

    /// Generate the next assistant message for a conversation.
    async complete(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
        const url = joinUrl(this.settings.endpointUrl, "/v1/chat/completions");
        const body = JSON.stringify({
            model: this.settings.model,
            messages,
            stream: false,
        });
        // The whole conversation goes into the log, it is what explains the answer of the model
        const request: Record<string, string> = { url: url.toString(), model: this.settings.model };
        messages.forEach((message, i) => { request[`message_${i}_${message.role}`] = message.content; });
        this.logger.info("Sending AI chat completion", request, LOG_CTX);
        const startedAt = Date.now();
        const response = await this.httpClient.fetch(url, {
            method: "POST",
            headers: buildHeaders(this.settings.headers, this.settings.auth),
            body,
            signal,
        });
        if (response.status < 200 || response.status >= 300) {
            const errBody = await response.text();
            this.logger.warn("AI chat completion failed", {
                model: this.settings.model,
                status: String(response.status),
                durationMs: String(Date.now() - startedAt),
                body: errBody,
            }, LOG_CTX);
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${errBody.slice(0, 200)}`);
        }
        const parsed = (await response.json()) as ChatCompletionResponse;
        const content = parsed.choices?.[0]?.message?.content ?? "";
        this.logger.info("Received AI chat completion", {
            model: this.settings.model,
            durationMs: String(Date.now() - startedAt),
            content,
        }, LOG_CTX);
        return content;
    }
}
