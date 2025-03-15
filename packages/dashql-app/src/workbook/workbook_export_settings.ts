
export interface WorkbookExportSettings {
    exportCatalog: boolean;
    exportUsername: boolean;
}

export function createDefaultExportSettings(): WorkbookExportSettings {
    return {
        exportCatalog: false,
        exportUsername: false,
    };
}


