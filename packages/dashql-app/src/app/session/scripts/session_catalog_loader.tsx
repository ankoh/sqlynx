import * as React from 'react';

import { CatalogLoaderProvider } from '../../connections/catalog_loader.js';
import { useConnectionScriptsDispatch } from './session_scripts_registry.js';
import { CATALOG_DID_UPDATE } from './session_scripts.js';

/// The catalog loader of the app, re-analyzes the scripts of every session that uses a connection
/// whose catalog changed.
export function SessionCatalogLoaderProvider(props: { children?: React.ReactElement }) {
    const connScriptsDispatch = useConnectionScriptsDispatch();
    const onCatalogDidUpdate = React.useCallback((connectionId: string) => {
        connScriptsDispatch(connectionId, { type: CATALOG_DID_UPDATE, value: null });
    }, [connScriptsDispatch]);
    return (
        <CatalogLoaderProvider onCatalogDidUpdate={onCatalogDidUpdate}>
            {props.children}
        </CatalogLoaderProvider>
    );
}
