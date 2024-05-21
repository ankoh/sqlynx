import { KeyValueListElement } from '../view/keyvalue_list.js';

export interface HyperGrpcMTLSParams {
    /// The mTLS client key path
    keyPath: string;
    /// The mTLS client certificate path
    pubPath: string;
    /// The mTLS ca certificates path
    caPath: string;
}

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    endpoint: string;
    /// The TLS config
    tlsConfig: HyperGrpcMTLSParams;
    /// The attached databases
    attachedDatabases: Immutable.List<KeyValueListElement>;
    /// The gRPC metadata
    gRPCMetadata: Immutable.List<KeyValueListElement>;
}

export interface SalesforceAuthParams {
    /// The base URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
}
