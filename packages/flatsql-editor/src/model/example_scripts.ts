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

import tpcds_schema from '../../static/examples/tpcds/schema.sql';
import tpcds_q1 from '../../static/examples/tpcds/01.sql';
import tpcds_q2 from '../../static/examples/tpcds/02.sql';
import tpcds_q3 from '../../static/examples/tpcds/03.sql';
import tpcds_q4 from '../../static/examples/tpcds/04.sql';
import tpcds_q5 from '../../static/examples/tpcds/05.sql';
import tpcds_q6 from '../../static/examples/tpcds/06.sql';
import tpcds_q7 from '../../static/examples/tpcds/07.sql';
import tpcds_q8 from '../../static/examples/tpcds/08.sql';
import tpcds_q9 from '../../static/examples/tpcds/09.sql';
import tpcds_q10 from '../../static/examples/tpcds/10.sql';
import tpcds_q11 from '../../static/examples/tpcds/11.sql';
import tpcds_q12 from '../../static/examples/tpcds/12.sql';
import tpcds_q13 from '../../static/examples/tpcds/13.sql';
import tpcds_q14a from '../../static/examples/tpcds/14a.sql';
import tpcds_q14b from '../../static/examples/tpcds/14b.sql';
import tpcds_q15 from '../../static/examples/tpcds/15.sql';
import tpcds_q16 from '../../static/examples/tpcds/16.sql';
import tpcds_q17 from '../../static/examples/tpcds/17.sql';
import tpcds_q18 from '../../static/examples/tpcds/18.sql';
import tpcds_q19 from '../../static/examples/tpcds/19.sql';
import tpcds_q20 from '../../static/examples/tpcds/20.sql';
import tpcds_q21 from '../../static/examples/tpcds/21.sql';
import tpcds_q22 from '../../static/examples/tpcds/22.sql';
import tpcds_q23a from '../../static/examples/tpcds/23a.sql';
import tpcds_q23b from '../../static/examples/tpcds/23b.sql';
import tpcds_q24a from '../../static/examples/tpcds/24a.sql';
import tpcds_q24b from '../../static/examples/tpcds/24b.sql';
import tpcds_q25 from '../../static/examples/tpcds/25.sql';
import tpcds_q26 from '../../static/examples/tpcds/26.sql';
import tpcds_q27 from '../../static/examples/tpcds/27.sql';
import tpcds_q28 from '../../static/examples/tpcds/28.sql';
import tpcds_q29 from '../../static/examples/tpcds/29.sql';
import tpcds_q30 from '../../static/examples/tpcds/30.sql';
import tpcds_q31 from '../../static/examples/tpcds/31.sql';
import tpcds_q32 from '../../static/examples/tpcds/32.sql';
import tpcds_q33 from '../../static/examples/tpcds/33.sql';
import tpcds_q34 from '../../static/examples/tpcds/34.sql';
import tpcds_q35 from '../../static/examples/tpcds/35.sql';
import tpcds_q36 from '../../static/examples/tpcds/36.sql';
import tpcds_q37 from '../../static/examples/tpcds/37.sql';
import tpcds_q38 from '../../static/examples/tpcds/38.sql';
import tpcds_q39a from '../../static/examples/tpcds/39a.sql';
import tpcds_q39b from '../../static/examples/tpcds/39b.sql';
import tpcds_q40 from '../../static/examples/tpcds/40.sql';
import tpcds_q41 from '../../static/examples/tpcds/41.sql';
import tpcds_q42 from '../../static/examples/tpcds/42.sql';
import tpcds_q43 from '../../static/examples/tpcds/43.sql';
import tpcds_q44 from '../../static/examples/tpcds/44.sql';
import tpcds_q45 from '../../static/examples/tpcds/45.sql';
import tpcds_q46 from '../../static/examples/tpcds/46.sql';
import tpcds_q47 from '../../static/examples/tpcds/47.sql';
import tpcds_q48 from '../../static/examples/tpcds/48.sql';
import tpcds_q49 from '../../static/examples/tpcds/49.sql';
import tpcds_q50 from '../../static/examples/tpcds/50.sql';
import tpcds_q51 from '../../static/examples/tpcds/51.sql';
import tpcds_q52 from '../../static/examples/tpcds/52.sql';
import tpcds_q53 from '../../static/examples/tpcds/53.sql';
import tpcds_q54 from '../../static/examples/tpcds/54.sql';
import tpcds_q55 from '../../static/examples/tpcds/55.sql';
import tpcds_q56 from '../../static/examples/tpcds/56.sql';
import tpcds_q57 from '../../static/examples/tpcds/57.sql';
import tpcds_q58 from '../../static/examples/tpcds/58.sql';
import tpcds_q59 from '../../static/examples/tpcds/59.sql';
import tpcds_q60 from '../../static/examples/tpcds/60.sql';
import tpcds_q61 from '../../static/examples/tpcds/61.sql';
import tpcds_q62 from '../../static/examples/tpcds/62.sql';
import tpcds_q63 from '../../static/examples/tpcds/63.sql';
import tpcds_q64 from '../../static/examples/tpcds/64.sql';
import tpcds_q65 from '../../static/examples/tpcds/65.sql';
import tpcds_q66 from '../../static/examples/tpcds/66.sql';
import tpcds_q67 from '../../static/examples/tpcds/67.sql';
import tpcds_q68 from '../../static/examples/tpcds/68.sql';
import tpcds_q69 from '../../static/examples/tpcds/69.sql';
import tpcds_q70 from '../../static/examples/tpcds/70.sql';
import tpcds_q71 from '../../static/examples/tpcds/71.sql';
import tpcds_q72 from '../../static/examples/tpcds/72.sql';
import tpcds_q73 from '../../static/examples/tpcds/73.sql';
import tpcds_q74 from '../../static/examples/tpcds/74.sql';
import tpcds_q75 from '../../static/examples/tpcds/75.sql';
import tpcds_q76 from '../../static/examples/tpcds/76.sql';
import tpcds_q77 from '../../static/examples/tpcds/77.sql';
import tpcds_q78 from '../../static/examples/tpcds/78.sql';
import tpcds_q79 from '../../static/examples/tpcds/79.sql';
import tpcds_q80 from '../../static/examples/tpcds/80.sql';
import tpcds_q81 from '../../static/examples/tpcds/81.sql';
import tpcds_q82 from '../../static/examples/tpcds/82.sql';
import tpcds_q83 from '../../static/examples/tpcds/83.sql';
import tpcds_q84 from '../../static/examples/tpcds/84.sql';
import tpcds_q85 from '../../static/examples/tpcds/85.sql';
import tpcds_q86 from '../../static/examples/tpcds/86.sql';
import tpcds_q87 from '../../static/examples/tpcds/87.sql';
import tpcds_q88 from '../../static/examples/tpcds/88.sql';
import tpcds_q89 from '../../static/examples/tpcds/89.sql';
import tpcds_q90 from '../../static/examples/tpcds/90.sql';
import tpcds_q91 from '../../static/examples/tpcds/91.sql';
import tpcds_q92 from '../../static/examples/tpcds/92.sql';
import tpcds_q93 from '../../static/examples/tpcds/93.sql';
import tpcds_q94 from '../../static/examples/tpcds/94.sql';
import tpcds_q95 from '../../static/examples/tpcds/95.sql';
import tpcds_q96 from '../../static/examples/tpcds/96.sql';
import tpcds_q97 from '../../static/examples/tpcds/97.sql';
import tpcds_q98 from '../../static/examples/tpcds/98.sql';

import ssb_schema from '../../static/examples/ssb/schema.sql';
import ssb_q11 from '../../static/examples/ssb/q11.sql';
import ssb_q12 from '../../static/examples/ssb/q12.sql';
import ssb_q13 from '../../static/examples/ssb/q13.sql';
import ssb_q21 from '../../static/examples/ssb/q21.sql';
import ssb_q22 from '../../static/examples/ssb/q22.sql';
import ssb_q23 from '../../static/examples/ssb/q23.sql';
import ssb_q31 from '../../static/examples/ssb/q31.sql';
import ssb_q32 from '../../static/examples/ssb/q32.sql';
import ssb_q33 from '../../static/examples/ssb/q33.sql';
import ssb_q34 from '../../static/examples/ssb/q34.sql';
import ssb_q41 from '../../static/examples/ssb/q41.sql';
import ssb_q42 from '../../static/examples/ssb/q42.sql';
import ssb_q43 from '../../static/examples/ssb/q43.sql';

const tpchSchema = example(ScriptType.SCHEMA, 'TPC-H Schema', tpch_schema);
const tpcdsSchema = example(ScriptType.SCHEMA, 'TPC-DS Schema', tpcds_schema);
const ssbSchema = example(ScriptType.SCHEMA, 'SSB Schema', ssb_schema);

export const exampleScripts = [
    tpchSchema,
    example(ScriptType.QUERY, 'TPC-H Query 1', tpch_q1, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 2', tpch_q2, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 3', tpch_q3, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 4', tpch_q4, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 5', tpch_q5, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 6', tpch_q6, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 7', tpch_q7, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 8', tpch_q8, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 9', tpch_q9, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 10', tpch_q10, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 11', tpch_q11, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 12', tpch_q12, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 13', tpch_q13, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 14', tpch_q14, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 15', tpch_q15, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 16', tpch_q16, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 17', tpch_q17, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 18', tpch_q18, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 19', tpch_q19, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 20', tpch_q20, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 21', tpch_q21, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-H Query 22', tpch_q22, tpchSchema.scriptId),

    tpcdsSchema,
    example(ScriptType.QUERY, 'TPC-DS Query 1', tpcds_q1, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 2', tpcds_q2, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 3', tpcds_q3, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 4', tpcds_q4, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 5', tpcds_q5, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 6', tpcds_q6, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 7', tpcds_q7, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 8', tpcds_q8, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 9', tpcds_q9, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 10', tpcds_q10, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 11', tpcds_q11, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 12', tpcds_q12, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 13', tpcds_q13, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 14a', tpcds_q14a, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 14b', tpcds_q14b, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 15', tpcds_q15, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 16', tpcds_q16, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 17', tpcds_q17, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 18', tpcds_q18, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 19', tpcds_q19, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 20', tpcds_q20, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 21', tpcds_q21, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 22', tpcds_q22, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 23a', tpcds_q23a, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 23b', tpcds_q23b, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 24a', tpcds_q24a, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 24b', tpcds_q24b, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 25', tpcds_q25, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 26', tpcds_q26, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 27', tpcds_q27, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 28', tpcds_q28, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 29', tpcds_q29, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 30', tpcds_q30, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 31', tpcds_q31, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 32', tpcds_q32, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 33', tpcds_q33, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 34', tpcds_q34, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 35', tpcds_q35, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 36', tpcds_q36, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 37', tpcds_q37, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 38', tpcds_q38, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 39a', tpcds_q39a, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 39b', tpcds_q39b, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 40', tpcds_q40, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 41', tpcds_q41, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 42', tpcds_q42, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 43', tpcds_q43, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 44', tpcds_q44, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 45', tpcds_q45, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 46', tpcds_q46, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 47', tpcds_q47, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 48', tpcds_q48, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 49', tpcds_q49, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 50', tpcds_q50, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 51', tpcds_q51, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 52', tpcds_q52, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 53', tpcds_q53, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 54', tpcds_q54, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 55', tpcds_q55, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 56', tpcds_q56, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 57', tpcds_q57, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 58', tpcds_q58, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 59', tpcds_q59, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 60', tpcds_q60, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 61', tpcds_q61, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 62', tpcds_q62, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 63', tpcds_q63, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 64', tpcds_q64, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 65', tpcds_q65, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 66', tpcds_q66, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 67', tpcds_q67, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 68', tpcds_q68, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 69', tpcds_q69, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 70', tpcds_q70, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 71', tpcds_q71, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 72', tpcds_q72, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 73', tpcds_q73, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 74', tpcds_q74, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 75', tpcds_q75, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 76', tpcds_q76, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 77', tpcds_q77, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 78', tpcds_q78, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 79', tpcds_q79, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 80', tpcds_q80, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 81', tpcds_q81, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 82', tpcds_q82, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 83', tpcds_q83, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 84', tpcds_q84, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 85', tpcds_q85, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 86', tpcds_q86, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 87', tpcds_q87, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 88', tpcds_q88, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 89', tpcds_q89, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 90', tpcds_q90, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 91', tpcds_q91, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 92', tpcds_q92, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 93', tpcds_q93, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 94', tpcds_q94, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 95', tpcds_q95, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 96', tpcds_q96, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 97', tpcds_q97, tpchSchema.scriptId),
    example(ScriptType.QUERY, 'TPC-DS Query 98', tpcds_q98, tpchSchema.scriptId),

    ssbSchema,
    example(ScriptType.QUERY, 'SSB Query 1', ssb_q11, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 2', ssb_q12, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 3', ssb_q13, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 1', ssb_q21, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 2', ssb_q22, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 3', ssb_q23, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 1', ssb_q31, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 2', ssb_q32, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 3', ssb_q33, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 4', ssb_q34, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 1', ssb_q41, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 2', ssb_q42, ssbSchema.scriptId),
    example(ScriptType.QUERY, 'SSB Query 3', ssb_q43, ssbSchema.scriptId),
];

console.log(exampleScripts);
