import * as React from 'react';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { Dispatch } from '../../../../utils/variant.js';
import { HyperSetupProvider } from './hyper_connection_setup.js';
import { HyperConnectorAction } from './hyper_connection_state.js';

export interface HyperConnectorApi {
    setup(dispatch: Dispatch<HyperConnectorAction>, params: connection.HyperConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<HyperConnectorAction>): Promise<void>
};

interface Props {
    children: React.ReactElement;
}

export const HyperConnector: React.FC<Props> = (props: Props) => {
    return (
        <HyperSetupProvider>
            {props.children}
        </HyperSetupProvider>
    );
};
