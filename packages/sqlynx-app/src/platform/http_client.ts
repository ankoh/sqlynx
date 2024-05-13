export interface ClientOptions {
    maxRedirections?: number;
    connectTimeout?: number;
}

export interface HttpClient {
    fetch(input: URL | Request | string, init?: RequestInit & ClientOptions): Promise<Response>;
}

