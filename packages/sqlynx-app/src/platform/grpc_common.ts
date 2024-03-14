
export interface GrpcChannelArgs {
    endpoint: string,
    tlsClientKeyPath?: string;
    tlsClientCertPath?: string;
    tlsCacertsPath?: string;
}

export class GrpcError extends Error {
    status: number;

    constructor(status: number, msg: string) {
        super(msg);
        this.status = status;
        Object.setPrototypeOf(this, GrpcError.prototype);
    }
}
