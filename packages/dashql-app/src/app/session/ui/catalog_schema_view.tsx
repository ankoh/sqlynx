import * as React from 'react';
import * as detailStyles from './script_details.module.css';

import { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CatalogScriptCard } from './catalog_script_card.js';
import { STORAGE_CATALOG_RELATIONS } from '../../storage/storage_backend.js';

export interface CatalogSchemaViewProps {
    connection: AttachedDatabaseState;
    onClose?: () => void;
}

export const CatalogSchemaView: React.FC<CatalogSchemaViewProps> = (props) => {
    const lastFullRefresh = props.connection.catalogUpdates.lastFullRefresh;

    return (
        <div className={detailStyles.entry_body_container}>
            <CatalogScriptCard
                script={props.connection.catalogRelationScript}
                fileName={STORAGE_CATALOG_RELATIONS}
                lastFullRefresh={lastFullRefresh}
                onClose={props.onClose}
            />
        </div>
    );
};
