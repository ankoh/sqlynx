import * as React from 'react';

import { UPDATE_CATALOG } from './script_state_reducer';
import { useScriptStateDispatch } from './script_state_provider';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import { useSalesforceConnector } from '../connectors/salesforce_connector';
import { UPDATE_SALESFORCE_DATA_CLOUD_METADATA } from '../connectors/salesforce_metadata_catalog';

interface Props {
    children?: React.ReactElement;
}

export const ScriptSalesforceMetadataCatalog: React.FC<Props> = (props: Props) => {
    const dispatch = useScriptStateDispatch();
    const connector = useSalesforceConnector();
    const authState = useSalesforceAuthState();
    React.useEffect(() => {
        if (!connector || !authState.dataCloudAccessToken) return;
        dispatch({
            type: UPDATE_CATALOG,
            value: {
                type: UPDATE_SALESFORCE_DATA_CLOUD_METADATA,
                value: {
                    api: connector,
                    accessToken: authState.dataCloudAccessToken,
                },
            },
        });
    }, [connector, authState.dataCloudAccessToken]);
    return props.children;
};
