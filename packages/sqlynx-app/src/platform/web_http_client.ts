import { ClientOptions, HttpClient } from './http_client.js';
import { Logger } from './logger.js';

export class WebHttpClient implements HttpClient {
    logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }
    public async fetch(input: URL | Request | string, init?: RequestInit & ClientOptions): Promise<Response> {
        return await fetch(input, init);
    }
}

