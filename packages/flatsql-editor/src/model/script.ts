export enum ScriptOriginType {
    LOCAL,
    GITHUB_GIST,
    HTTP,
}

export enum ScriptType {
    UNKNOWN,
    QUERY,
    SCHEMA,
}

export interface Script {
    /// The script id
    scriptId: string;
    /// The script type
    scriptType: ScriptType;
    /// The name
    name: string;
    /// The content
    content: string | null;
    /// The origin type
    originType: ScriptOriginType;
    /// The http url
    httpURL: URL | null;
    /// The github account
    githubAccount: string | null;
    /// The github gist name
    githubGistName: string | null;
    /// The schema id
    schemaId: string | null;
}

export function createScript(script: Omit<Script, 'scriptId'>): Script {
    const s = script as any;
    switch (script.originType) {
        case ScriptOriginType.HTTP:
            s.scriptId = script.httpURL;
            break;
        case ScriptOriginType.GITHUB_GIST:
            s.scriptId = `${script.githubAccount}/${script.githubGistName}`;
            break;
        case ScriptOriginType.LOCAL:
            s.scriptId = script.name;
            break;
    }
    return s as Script;
}

export function getScriptOriginTypeName(origin: ScriptOriginType): string {
    switch (origin) {
        case ScriptOriginType.LOCAL:
            return 'local';
        case ScriptOriginType.GITHUB_GIST:
            return 'gist';
        case ScriptOriginType.HTTP:
            return 'http';
    }
}

export function getScriptTags(script: Script): string[] {
    const beans = [];
    switch (script.originType) {
        case ScriptOriginType.LOCAL:
            beans.push('Local');
            break;
        case ScriptOriginType.GITHUB_GIST:
            beans.push('Gist');
            break;
    }
    return beans;
}
