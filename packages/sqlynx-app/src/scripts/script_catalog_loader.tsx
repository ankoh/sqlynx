import * as React from 'react';

import { useScriptState, useScriptStateDispatch } from '../scripts/script_state_provider';
import { CATALOG_WAS_UPDATED } from '../scripts/script_state_reducer';
import { CatalogLoader } from '../connectors/catalog_loader';

export const ScriptCatalogLoader = (props: { children: React.ReactElement }) => {
    const state = useScriptState();
    const dispatch = useScriptStateDispatch();
    const catalogWasUpdated = React.useCallback(() => {
        dispatch({
            type: CATALOG_WAS_UPDATED,
            value: null,
        });
    }, [dispatch]);
    return (
        <CatalogLoader catalog={state.catalog} catalogWasUpdated={catalogWasUpdated}>
            {props.children}
        </CatalogLoader>
    );
};
