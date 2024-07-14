import * as sqlynx from '@ankoh/sqlynx-core';

export class CatalogSnapshotReader {
    catalogReader: sqlynx.proto.FlatCatalog;
    nameDictionary: (string | null)[];

    constructor(catalog: sqlynx.proto.FlatCatalog, nameDictionary: (string | null)[]) {
        this.catalogReader = catalog;
        this.nameDictionary = nameDictionary;
    }

    public readName(nameId: number): string {
        let name = this.nameDictionary[nameId];
        if (name == null) {
            name = this.catalogReader.nameDictionary(nameId);
            this.nameDictionary[nameId] = name;
        }
        return name;
    }
}

export class CatalogSnapshot {
    snapshot: sqlynx.FlatBufferPtr<sqlynx.proto.FlatCatalog>;
    nameDictionary: (string | null)[];

    constructor(snapshot: sqlynx.FlatBufferPtr<sqlynx.proto.FlatCatalog>) {
        this.snapshot = snapshot;
        this.nameDictionary = [];
    }

    public read(): CatalogSnapshotReader {
        const reader = this.snapshot.read(new sqlynx.proto.FlatCatalog());
        return new CatalogSnapshotReader(reader, this.nameDictionary);

    }
}
