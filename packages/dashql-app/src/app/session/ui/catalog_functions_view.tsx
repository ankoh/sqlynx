import * as React from 'react';
import * as detailStyles from './script_details.module.css';

import { ConnectionState } from '../../connections/connection_state.js';
import { CatalogScriptCard } from './catalog_script_card.js';
import { STORAGE_CATALOG_FUNCTIONS } from '../../storage/storage_backend.js';

export interface CatalogFunctionsViewProps {
    connection: ConnectionState;
    onClose?: () => void;
}

export const CatalogFunctionsView: React.FC<CatalogFunctionsViewProps> = (props) => {
    const lastFullRefresh = props.connection.catalogUpdates.lastFullRefresh;

    return (
        <div className={detailStyles.entry_body_container}>
            <CatalogScriptCard
                script={props.connection.catalogFunctionScript}
                fileName={STORAGE_CATALOG_FUNCTIONS}
                lastFullRefresh={lastFullRefresh}
                onClose={props.onClose}
            />
        </div>
    );
};
