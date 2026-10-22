

interface SalesforceMetadataEntityField {
    name: string;
    displayName: string;
    type: string;
    businessType: string;
}

interface SalesforceMetadataPrimaryKey {
    indexOrder: string;
    name: string;
    displayName: string;
}

interface SalesforceMetadataEntity {
    name: string;
    displayName: string;
    category: string;
    fields: SalesforceMetadataEntityField[];
    primaryKeys: SalesforceMetadataPrimaryKey[];
}

interface SalesforceMetadata {
    metadata?: SalesforceMetadataEntity[];
}
