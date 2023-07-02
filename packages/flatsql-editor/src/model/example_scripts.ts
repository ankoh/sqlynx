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
import tpch_q3 from '../../static/examples/tpch/q3.sql';
import tpch_q4 from '../../static/examples/tpch/q4.sql';
import tpch_q5 from '../../static/examples/tpch/q5.sql';
import tpch_q6 from '../../static/examples/tpch/q6.sql';
import tpch_q7 from '../../static/examples/tpch/q7.sql';
import tpch_q8 from '../../static/examples/tpch/q8.sql';
import tpch_q9 from '../../static/examples/tpch/q9.sql';
import tpch_q10 from '../../static/examples/tpch/q10.sql';
import tpch_q11 from '../../static/examples/tpch/q11.sql';
import tpch_q12 from '../../static/examples/tpch/q12.sql';
import tpch_q13 from '../../static/examples/tpch/q13.sql';
import tpch_q14 from '../../static/examples/tpch/q14.sql';
import tpch_q15 from '../../static/examples/tpch/q15.sql';
import tpch_q16 from '../../static/examples/tpch/q16.sql';
import tpch_q17 from '../../static/examples/tpch/q17.sql';
import tpch_q18 from '../../static/examples/tpch/q18.sql';
import tpch_q19 from '../../static/examples/tpch/q19.sql';
import tpch_q20 from '../../static/examples/tpch/q20.sql';
import tpch_q21 from '../../static/examples/tpch/q21.sql';
import tpch_q22 from '../../static/examples/tpch/q22.sql';

const tpchSchema = example(ScriptType.SCHEMA, 'TPCH Schema', tpch_schema);

export const exampleScripts = [
    tpchSchema,
    example(ScriptType.QUERY, 'TPCH Query 1', tpch_q1, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 2', tpch_q2, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 3', tpch_q3, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 4', tpch_q4, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 5', tpch_q5, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 6', tpch_q6, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 7', tpch_q7, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 8', tpch_q8, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 9', tpch_q9, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 10', tpch_q10, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 11', tpch_q11, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 12', tpch_q12, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 13', tpch_q13, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 14', tpch_q14, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 15', tpch_q15, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 16', tpch_q16, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 17', tpch_q17, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 18', tpch_q18, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 19', tpch_q19, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 20', tpch_q20, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 21', tpch_q21, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPCH Query 22', tpch_q22, tpchSchema.scriptId),
];
console.log(exampleScripts);
