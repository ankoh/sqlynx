import { HyperGrpcConnectorAction } from './hyper_grpc_connection_state.js';
import { Logger } from '../platform/logger.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperGrpcConnectorConfig } from './connector_configs.js';
import { Dispatch } from '../utils/index.js';


export async function authorizeSalesforceConnection(_dispatch: Dispatch<HyperGrpcConnectorAction>, _logger: Logger, _params: HyperGrpcConnectionParams, _config: HyperGrpcConnectorConfig, _abortSignal: AbortSignal): Promise<void> {
}
