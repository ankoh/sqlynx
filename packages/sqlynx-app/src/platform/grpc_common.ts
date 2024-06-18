export interface GrpcTlsSettings {
    /// The mTLS client key path
    keyPath?: string;
    /// The mTLS client certificate path
    pubPath?: string;
    /// The mTLS ca certificates path
    caPath?: string;
}

export interface GrpcChannelArgs {
    endpoint: string,
    tls?: GrpcTlsSettings;
}

export class GrpcError extends Error {
    grpcStatus: number;
    headers: Record<string, string> | null;

    constructor(status: number, msg: string, headers?: Record<string, string>) {
        super(msg);
        this.grpcStatus = status;
        this.headers = headers ?? null;
        Object.setPrototypeOf(this, GrpcError.prototype);
    }
}

export interface GrpcMetadataProvider {
    /// Get additional request metadata.
    /// Retrieving the request metadata might involve refreshing the OAuth token, thus the promise.
    getRequestMetadata(): Promise<Record<string, string>>;
}
