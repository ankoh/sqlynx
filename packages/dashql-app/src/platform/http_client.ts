export interface ClientOptions {
    maxRedirections?: number;
    connectTimeout?: number;
}

/// A `Response` subset that is also implemented by our native http proxy
export interface HttpFetchResult {
    headers: Headers,
    status: number,
    statusText: string,

    arrayBuffer(): Promise<ArrayBuffer>;
    json(): Promise<any>;
}

/// An abstract http client
export interface HttpClient {
    fetch(input: URL | Request | string, init?: RequestInit & ClientOptions): Promise<HttpFetchResult>;
}

