import type { CatalogNameDefaults } from '@ankoh/dashql-core';

import { HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { DEFAULT_DATABASE_NAME } from './catalog_sql_generator.js';
import { SALESFORCE_CATALOG_DATABASE, SALESFORCE_CATALOG_SCHEMA } from './salesforce/salesforce_catalog_update.js';
import type { ConnectionStateDetailsVariant } from './connection_state_details.js';

/// The default schema of Hyper
const HYPER_DEFAULT_SCHEMA = 'public';

/// The database and schema of the relations that unqualified statements create or drop on a connection.
/// They match the names that the catalog loaders give the relations of the connection.
export function catalogNameDefaults(details: ConnectionStateDetailsVariant): CatalogNameDefaults {
    switch (details.type) {
        case HYPER_CONNECTOR: {
            // Unqualified names resolve against the first attached database
            const attached = details.value.proto.setupParams?.attachedDatabases ?? [];
            const databaseName = attached.length > 0 ? (attached[0].alias ?? '') : DEFAULT_DATABASE_NAME;
            return { databaseName, schemaName: HYPER_DEFAULT_SCHEMA };
        }
        case TRINO_CONNECTOR:
            // Queries name the catalog but no schema, the server rejects relations without a schema
            return { databaseName: details.value.proto.setupParams?.catalogName ?? '', schemaName: '' };
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return { databaseName: SALESFORCE_CATALOG_DATABASE, schemaName: SALESFORCE_CATALOG_SCHEMA };
    }
}
