export enum ScriptOriginType {
    LOCAL,
    HTTP,
}

export enum ScriptType {
    UNKNOWN,
    QUERY,
    SCHEMA,
}

export interface ScriptAnnotations {
    /// The foundations tables
    tableRefs?: Set<string>;
    /// The query_result definitions
    tableDefs?: Set<string>;
    /// The tenant name (if any)
    tenantName?: string;
    /// The org name (if any)
    orgName?: string;
}

export interface ScriptMetadata {
    /// The pseudo context id
    scriptId: string;
    /// The schema id
    schemaId: string | null;
    /// The name
    name: string | null;
    /// The script type
    scriptType: ScriptType;
    /// The origin type
    originType: ScriptOriginType;
    /// The http url
    httpURL: URL | null;
    /// The statistics
    annotations: ScriptAnnotations | null;
    /// Is the script immutable?
    immutable: boolean;
}

export function generateBlankScript(): ScriptMetadata {
    return createScriptMetadata({
        schemaId: null,
        name: null,
        scriptType: ScriptType.UNKNOWN,
        originType: ScriptOriginType.LOCAL,
        httpURL: null,
        annotations: null,
        immutable: false,
    });
}

export function createScriptMetadata(script: Omit<ScriptMetadata, 'scriptId'>): ScriptMetadata {
    const s = script as any;
    switch (script.originType) {
        case ScriptOriginType.HTTP:
            s.scriptId = script.httpURL;
            break;
        case ScriptOriginType.LOCAL:
            s.scriptId = script.name;
            break;
    }
    return s as ScriptMetadata;
}

export function getScriptOriginTypeName(origin: ScriptOriginType): string {
    switch (origin) {
        case ScriptOriginType.LOCAL:
            return 'local';
        case ScriptOriginType.HTTP:
            return 'http';
    }
}

export function getScriptTags(script: ScriptMetadata): string[] {
    const beans = [];
    switch (script.originType) {
        case ScriptOriginType.LOCAL:
            beans.push('Local');
            break;
    }
    return beans;
}
