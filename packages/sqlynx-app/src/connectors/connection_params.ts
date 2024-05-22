import Immutable from 'immutable';
import { KeyValueListElement } from '../view/keyvalue_list.js';
import { GrpcChannelArgs } from '../platform/grpc_common.js';

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    channel: GrpcChannelArgs;
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
