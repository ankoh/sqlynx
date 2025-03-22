import '@jest/globals';

import * as pb from '@ankoh/dashql-protobuf';

import { decodeCatalogFileFromProto } from './catalog_import.js';

describe('Catalog Import', () => {
    it('can import example file catalog', async () => {
        const catalogPb = new pb.dashql.file.FileCatalog({
            connectionParams: new pb.dashql.connection.ConnectionParams({
                connection: {
                    case: "demo",
                    value: {}
                }
            }),
            catalog: {
                databases: [
                    new pb.dashql.catalog.CatalogDatabase({
                        name: "db1",
                        schemas: [
                            new pb.dashql.catalog.CatalogSchema({
                                name: "schema1",
                                tables: [
                                    new pb.dashql.catalog.CatalogTable({
                                        name: "table1",
                                        columns: [
                                            new pb.dashql.catalog.CatalogColumn({ name: "column1" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column2" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column3" }),
                                        ]
                                    }),
                                    new pb.dashql.catalog.CatalogTable({
                                        name: "table2",
                                        columns: [
                                            new pb.dashql.catalog.CatalogColumn({ name: "column1" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column2" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column3" }),
                                        ]
                                    })
                                ]
                            }),
                            new pb.dashql.catalog.CatalogSchema({
                                name: "schema2",
                                tables: [
                                    new pb.dashql.catalog.CatalogTable({
                                        name: "table1",
                                        columns: [
                                            new pb.dashql.catalog.CatalogColumn({ name: "column1" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column2" }),
                                            new pb.dashql.catalog.CatalogColumn({ name: "column3" }),
                                        ]
                                    })
                                ]
                            })
                        ]
                    })
                ]
            }
        });

        const schemaDescriptors = decodeCatalogFileFromProto(catalogPb);
        expect(schemaDescriptors.schemas.length).toEqual(2);
        expect(schemaDescriptors.schemas[0].tables.length).toEqual(2);
        expect(schemaDescriptors.schemas[0].tables[0].columns.length).toEqual(3);
        expect(schemaDescriptors.schemas[0].tables[1].columns.length).toEqual(3);
        expect(schemaDescriptors.schemas[1].tables.length).toEqual(1);
        expect(schemaDescriptors.schemas[1].tables[0].columns.length).toEqual(3);
    });
});

