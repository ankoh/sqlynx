import * as React from 'react';

import { Dispatch } from '../../utils/variant.js';
import { HyperGrpcConnectionParams } from './hyper_connection_params.js';
import { HyperGrpcSetupProvider } from './hyper_connection_setup.js';
import { HyperGrpcConnectorAction } from './hyper_connection_state.js';

export interface HyperGrpcConnectorApi {
    setup(dispatch: Dispatch<HyperGrpcConnectorAction>, params: HyperGrpcConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<HyperGrpcConnectorAction>): Promise<void>
};

interface Props {
    children: React.ReactElement;
}

export const HyperGrpcConnector: React.FC<Props> = (props: Props) => {
    return (
        <HyperGrpcSetupProvider>
            {props.children}
        </HyperGrpcSetupProvider>
    );
};

