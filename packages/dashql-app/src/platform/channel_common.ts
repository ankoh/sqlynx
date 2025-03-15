import { DetailedError } from "utils/error.js";

export interface ChannelTlsSettings {
    /// The mTLS client key path
    keyPath?: string;
    /// The mTLS client certificate path
    pubPath?: string;
    /// The mTLS ca certificates path
    caPath?: string;
}

export interface ChannelArgs {
    /// The endpoint url
    endpoint: string,
    /// The channel tls settings
    tls?: ChannelTlsSettings;
}

export interface RawProxyError {
    /// The error
    message: string;
    /// The details
    details?: Record<string, string>;
}

export class ChannelError extends Error implements DetailedError {
    /// The details (if any)
    details: Record<string, string>;
    /// The status code
    statusCode: number;
    /// The response headers
    headers: Headers | null;

    constructor(error: RawProxyError, status: number, headers?: Headers) {
        super(error.message);
        this.details = error.details ?? {};
        this.statusCode = status;
        this.headers = headers ?? null;
        Object.setPrototypeOf(this, ChannelError.prototype);
    }
}

export interface ChannelMetadataProvider {
    /// Get additional request metadata.
    /// Retrieving the request metadata might involve refreshing the OAuth token, thus the promise.
    getRequestMetadata(): Promise<Record<string, string>>;
}
