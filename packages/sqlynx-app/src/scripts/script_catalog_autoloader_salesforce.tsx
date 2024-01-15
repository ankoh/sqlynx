import * as React from 'react';

import { UPDATE_CATALOG } from './script_state_reducer';
import { useScriptStateDispatch } from './script_state_provider';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import { useSalesforceAPI } from '../connectors/salesforce_connector';
import { FULL_CATALOG_REFRESH } from '../connectors/catalog_update';

interface Props {
    children?: React.ReactElement;
}

export const ScriptCatalogSalesforceAutoloader: React.FC<Props> = (props: Props) => {
    const dispatch = useScriptStateDispatch();
    const connector = useSalesforceAPI();
    const authState = useSalesforceAuthState();
    React.useEffect(() => {
        if (!connector || !authState.dataCloudAccessToken) return;
        dispatch({
            type: UPDATE_CATALOG,
            value: {
                type: FULL_CATALOG_REFRESH,
                value: null,
            },
        });
    }, [connector, authState.dataCloudAccessToken]);
    return props.children;
};
