import { Script, ScriptType, ScriptOriginType, createScript } from './script';

function example(scriptType: ScriptType, name: string, url: URL, schemaId: string | null = null): Script {
    return createScript({
        scriptType,
        name,
        content: null,
        originType: ScriptOriginType.HTTP,
        httpURL: url,
        githubAccount: null,
        githubGistName: null,
        schemaId,
    });
}

import tpch_schema from '../../static/examples/tpch/schema.sql';
import tpch_q1 from '../../static/examples/tpch/q1.sql';
import tpch_q2 from '../../static/examples/tpch/q2.sql';

const tpchSchema = example(ScriptType.SCHEMA, 'TPCH Schema', tpch_schema);

export const exampleScripts = [
    tpchSchema,
    example(ScriptType.QUERY, 'TPCH Query 1', tpch_q1, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 2', tpch_q2, tpchSchema.scriptId),
];
console.log(exampleScripts);
