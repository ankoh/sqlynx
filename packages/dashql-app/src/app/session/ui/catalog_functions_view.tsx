import * as React from 'react';
import * as detailStyles from './script_details.module.css';

import { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CatalogScriptCard } from './catalog_script_card.js';
import { STORAGE_CATALOG_FUNCTIONS } from '../persistence/storage_backend.js';

export interface CatalogFunctionsViewProps {
    connection: AttachedDatabaseState;
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
