
export interface GrpcChannelArgs {
    endpoint: string,
    tlsClientKeyPath?: string;
    tlsClientCertPath?: string;
    tlsCacertsPath?: string;
}

export class GrpcError extends Error {
    status: number;
    headers: Record<string, string> | null;

    constructor(status: number, msg: string, headers?: Record<string, string>) {
        super(msg);
        this.status = status;
        this.headers = headers ?? null;
        Object.setPrototypeOf(this, GrpcError.prototype);
    }
}
