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

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface ChatCompletionResponse {
    choices?: { message?: { content?: string } }[];
}

interface ListModelsResponse {
    data?: { id?: string }[];
}

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
        const url = joinUrl(this.settings.endpointUrl, "/v1/chat/completions");
        const messages: ChatMessage[] = [{ role: "user", content: prompt }];
        const body = JSON.stringify({
            model: this.settings.model,
            messages,
            stream: false,
        });
        this.logger.debug("Calling AI chat completion", { url: url.toString(), model: this.settings.model }, LOG_CTX);
        const response = await this.httpClient.fetch(url, {
            method: "POST",
            headers: buildHeaders(this.settings.headers, this.settings.auth),
            body,
            signal,
        });
        if (response.status < 200 || response.status >= 300) {
            const errBody = await response.text();
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${errBody.slice(0, 200)}`);
        }
        const parsed = (await response.json()) as ChatCompletionResponse;
        const content = parsed.choices?.[0]?.message?.content ?? "";
        this.logger.debug("Received AI chat completion", { length: String(content.length) }, LOG_CTX);
        return content;
    }
}
