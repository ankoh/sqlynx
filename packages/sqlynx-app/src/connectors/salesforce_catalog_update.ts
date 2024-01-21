import * as sqlynx from '@ankoh/sqlynx';

import { SalesforceMetadata } from './salesforce_api_client';

export function updateDataCloudCatalog(catalog: sqlynx.SQLynxCatalog, metadata: SalesforceMetadata) {
    const tables: sqlynx.proto.SchemaTableT[] = [];
    for (const entry of metadata.metadata) {
        const table = new sqlynx.proto.SchemaTableT();
        table.tableName = entry.name;
        for (const field of entry.fields) {
            table.columns.push(new sqlynx.proto.SchemaTableColumnT(field.name));
        }
        tables.push(table);
    }

    console.log('drop descriptor pool');
    catalog.dropDescriptorPool(42);
    console.log('add descriptor pool');
    catalog.addDescriptorPool(42, 100);
    console.log('add schema descriptor');
    const descriptor = new sqlynx.proto.SchemaDescriptorT('', '', tables);
    catalog.addSchemaDescriptorT(42, descriptor);

    console.log(metadata);
    console.log('catalog.clear()');
}
