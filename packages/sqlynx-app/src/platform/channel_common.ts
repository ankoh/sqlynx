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

export class ChannelError extends Error {
    /// The gRPC status
    grpcStatus: number;
    /// The headers
    headers: Record<string, string> | null;

    constructor(status: number, msg: string, headers?: Record<string, string>) {
        super(msg);
        this.grpcStatus = status;
        this.headers = headers ?? null;
        Object.setPrototypeOf(this, ChannelError.prototype);
    }
}

export interface ChannelMetadataProvider {
    /// Get additional request metadata.
    /// Retrieving the request metadata might involve refreshing the OAuth token, thus the promise.
    getRequestMetadata(): Promise<Record<string, string>>;
}
