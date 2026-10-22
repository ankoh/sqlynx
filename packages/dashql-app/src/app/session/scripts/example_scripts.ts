export interface ExampleScript {
    source: URL;
    scriptName: string;
    schemaName: string | null;
}

export function createExampleMetadata(name: string, url: URL, schemaRef: string | null): ExampleScript {
    return {
        source: url,
        scriptName: name,
        schemaName: schemaRef,
    };
}

const tpch_schema = new URL('../../static/examples/tpch/schema.sql', import.meta.url);
const tpch_q1 = new URL('../../static/examples/tpch/q1.sql', import.meta.url);
const tpch_q2 = new URL('../../static/examples/tpch/q2.sql', import.meta.url);
const tpch_q3 = new URL('../../static/examples/tpch/q3.sql', import.meta.url);
const tpch_q4 = new URL('../../static/examples/tpch/q4.sql', import.meta.url);
const tpch_q5 = new URL('../../static/examples/tpch/q5.sql', import.meta.url);
const tpch_q6 = new URL('../../static/examples/tpch/q6.sql', import.meta.url);
const tpch_q7 = new URL('../../static/examples/tpch/q7.sql', import.meta.url);
const tpch_q8 = new URL('../../static/examples/tpch/q8.sql', import.meta.url);
const tpch_q9 = new URL('../../static/examples/tpch/q9.sql', import.meta.url);
const tpch_q10 = new URL('../../static/examples/tpch/q10.sql', import.meta.url);
const tpch_q11 = new URL('../../static/examples/tpch/q11.sql', import.meta.url);
const tpch_q12 = new URL('../../static/examples/tpch/q12.sql', import.meta.url);
const tpch_q13 = new URL('../../static/examples/tpch/q13.sql', import.meta.url);
const tpch_q14 = new URL('../../static/examples/tpch/q14.sql', import.meta.url);
const tpch_q15 = new URL('../../static/examples/tpch/q15.sql', import.meta.url);
const tpch_q16 = new URL('../../static/examples/tpch/q16.sql', import.meta.url);
const tpch_q17 = new URL('../../static/examples/tpch/q17.sql', import.meta.url);
const tpch_q18 = new URL('../../static/examples/tpch/q18.sql', import.meta.url);
const tpch_q19 = new URL('../../static/examples/tpch/q19.sql', import.meta.url);
const tpch_q20 = new URL('../../static/examples/tpch/q20.sql', import.meta.url);
const tpch_q21 = new URL('../../static/examples/tpch/q21.sql', import.meta.url);
const tpch_q22 = new URL('../../static/examples/tpch/q22.sql', import.meta.url);

const tpcds_schema = new URL('../../static/examples/tpcds/schema.sql', import.meta.url);
const tpcds_q1 = new URL('../../static/examples/tpcds/01.sql', import.meta.url);
const tpcds_q2 = new URL('../../static/examples/tpcds/02.sql', import.meta.url);
const tpcds_q3 = new URL('../../static/examples/tpcds/03.sql', import.meta.url);
const tpcds_q4 = new URL('../../static/examples/tpcds/04.sql', import.meta.url);
const tpcds_q5 = new URL('../../static/examples/tpcds/05.sql', import.meta.url);
const tpcds_q6 = new URL('../../static/examples/tpcds/06.sql', import.meta.url);
const tpcds_q7 = new URL('../../static/examples/tpcds/07.sql', import.meta.url);
const tpcds_q8 = new URL('../../static/examples/tpcds/08.sql', import.meta.url);
const tpcds_q9 = new URL('../../static/examples/tpcds/09.sql', import.meta.url);
const tpcds_q10 = new URL('../../static/examples/tpcds/10.sql', import.meta.url);
const tpcds_q11 = new URL('../../static/examples/tpcds/11.sql', import.meta.url);
const tpcds_q12 = new URL('../../static/examples/tpcds/12.sql', import.meta.url);
const tpcds_q13 = new URL('../../static/examples/tpcds/13.sql', import.meta.url);
const tpcds_q14a = new URL('../../static/examples/tpcds/14a.sql', import.meta.url);
const tpcds_q14b = new URL('../../static/examples/tpcds/14b.sql', import.meta.url);
const tpcds_q15 = new URL('../../static/examples/tpcds/15.sql', import.meta.url);
const tpcds_q16 = new URL('../../static/examples/tpcds/16.sql', import.meta.url);
const tpcds_q17 = new URL('../../static/examples/tpcds/17.sql', import.meta.url);
const tpcds_q18 = new URL('../../static/examples/tpcds/18.sql', import.meta.url);
const tpcds_q19 = new URL('../../static/examples/tpcds/19.sql', import.meta.url);
const tpcds_q20 = new URL('../../static/examples/tpcds/20.sql', import.meta.url);
const tpcds_q21 = new URL('../../static/examples/tpcds/21.sql', import.meta.url);
const tpcds_q22 = new URL('../../static/examples/tpcds/22.sql', import.meta.url);
const tpcds_q23a = new URL('../../static/examples/tpcds/23a.sql', import.meta.url);
const tpcds_q23b = new URL('../../static/examples/tpcds/23b.sql', import.meta.url);
const tpcds_q24a = new URL('../../static/examples/tpcds/24a.sql', import.meta.url);
const tpcds_q24b = new URL('../../static/examples/tpcds/24b.sql', import.meta.url);
const tpcds_q25 = new URL('../../static/examples/tpcds/25.sql', import.meta.url);
const tpcds_q26 = new URL('../../static/examples/tpcds/26.sql', import.meta.url);
const tpcds_q27 = new URL('../../static/examples/tpcds/27.sql', import.meta.url);
const tpcds_q28 = new URL('../../static/examples/tpcds/28.sql', import.meta.url);
const tpcds_q29 = new URL('../../static/examples/tpcds/29.sql', import.meta.url);
const tpcds_q30 = new URL('../../static/examples/tpcds/30.sql', import.meta.url);
const tpcds_q31 = new URL('../../static/examples/tpcds/31.sql', import.meta.url);
const tpcds_q32 = new URL('../../static/examples/tpcds/32.sql', import.meta.url);
const tpcds_q33 = new URL('../../static/examples/tpcds/33.sql', import.meta.url);
const tpcds_q34 = new URL('../../static/examples/tpcds/34.sql', import.meta.url);
const tpcds_q35 = new URL('../../static/examples/tpcds/35.sql', import.meta.url);
const tpcds_q36 = new URL('../../static/examples/tpcds/36.sql', import.meta.url);
const tpcds_q37 = new URL('../../static/examples/tpcds/37.sql', import.meta.url);
const tpcds_q38 = new URL('../../static/examples/tpcds/38.sql', import.meta.url);
const tpcds_q39a = new URL('../../static/examples/tpcds/39a.sql', import.meta.url);
const tpcds_q39b = new URL('../../static/examples/tpcds/39b.sql', import.meta.url);
const tpcds_q40 = new URL('../../static/examples/tpcds/40.sql', import.meta.url);
const tpcds_q41 = new URL('../../static/examples/tpcds/41.sql', import.meta.url);
const tpcds_q42 = new URL('../../static/examples/tpcds/42.sql', import.meta.url);
const tpcds_q43 = new URL('../../static/examples/tpcds/43.sql', import.meta.url);
const tpcds_q44 = new URL('../../static/examples/tpcds/44.sql', import.meta.url);
const tpcds_q45 = new URL('../../static/examples/tpcds/45.sql', import.meta.url);
const tpcds_q46 = new URL('../../static/examples/tpcds/46.sql', import.meta.url);
const tpcds_q47 = new URL('../../static/examples/tpcds/47.sql', import.meta.url);
const tpcds_q48 = new URL('../../static/examples/tpcds/48.sql', import.meta.url);
const tpcds_q49 = new URL('../../static/examples/tpcds/49.sql', import.meta.url);
const tpcds_q50 = new URL('../../static/examples/tpcds/50.sql', import.meta.url);
const tpcds_q51 = new URL('../../static/examples/tpcds/51.sql', import.meta.url);
const tpcds_q52 = new URL('../../static/examples/tpcds/52.sql', import.meta.url);
const tpcds_q53 = new URL('../../static/examples/tpcds/53.sql', import.meta.url);
const tpcds_q54 = new URL('../../static/examples/tpcds/54.sql', import.meta.url);
const tpcds_q55 = new URL('../../static/examples/tpcds/55.sql', import.meta.url);
const tpcds_q56 = new URL('../../static/examples/tpcds/56.sql', import.meta.url);
const tpcds_q57 = new URL('../../static/examples/tpcds/57.sql', import.meta.url);
const tpcds_q58 = new URL('../../static/examples/tpcds/58.sql', import.meta.url);
const tpcds_q59 = new URL('../../static/examples/tpcds/59.sql', import.meta.url);
const tpcds_q60 = new URL('../../static/examples/tpcds/60.sql', import.meta.url);
const tpcds_q61 = new URL('../../static/examples/tpcds/61.sql', import.meta.url);
const tpcds_q62 = new URL('../../static/examples/tpcds/62.sql', import.meta.url);
const tpcds_q63 = new URL('../../static/examples/tpcds/63.sql', import.meta.url);
const tpcds_q64 = new URL('../../static/examples/tpcds/64.sql', import.meta.url);
const tpcds_q65 = new URL('../../static/examples/tpcds/65.sql', import.meta.url);
const tpcds_q66 = new URL('../../static/examples/tpcds/66.sql', import.meta.url);
const tpcds_q67 = new URL('../../static/examples/tpcds/67.sql', import.meta.url);
const tpcds_q68 = new URL('../../static/examples/tpcds/68.sql', import.meta.url);
const tpcds_q69 = new URL('../../static/examples/tpcds/69.sql', import.meta.url);
const tpcds_q70 = new URL('../../static/examples/tpcds/70.sql', import.meta.url);
const tpcds_q71 = new URL('../../static/examples/tpcds/71.sql', import.meta.url);
const tpcds_q72 = new URL('../../static/examples/tpcds/72.sql', import.meta.url);
const tpcds_q73 = new URL('../../static/examples/tpcds/73.sql', import.meta.url);
const tpcds_q74 = new URL('../../static/examples/tpcds/74.sql', import.meta.url);
const tpcds_q75 = new URL('../../static/examples/tpcds/75.sql', import.meta.url);
const tpcds_q76 = new URL('../../static/examples/tpcds/76.sql', import.meta.url);
const tpcds_q77 = new URL('../../static/examples/tpcds/77.sql', import.meta.url);
const tpcds_q78 = new URL('../../static/examples/tpcds/78.sql', import.meta.url);
const tpcds_q79 = new URL('../../static/examples/tpcds/79.sql', import.meta.url);
const tpcds_q80 = new URL('../../static/examples/tpcds/80.sql', import.meta.url);
const tpcds_q81 = new URL('../../static/examples/tpcds/81.sql', import.meta.url);
const tpcds_q82 = new URL('../../static/examples/tpcds/82.sql', import.meta.url);
const tpcds_q83 = new URL('../../static/examples/tpcds/83.sql', import.meta.url);
const tpcds_q84 = new URL('../../static/examples/tpcds/84.sql', import.meta.url);
const tpcds_q85 = new URL('../../static/examples/tpcds/85.sql', import.meta.url);
const tpcds_q86 = new URL('../../static/examples/tpcds/86.sql', import.meta.url);
const tpcds_q87 = new URL('../../static/examples/tpcds/87.sql', import.meta.url);
const tpcds_q88 = new URL('../../static/examples/tpcds/88.sql', import.meta.url);
const tpcds_q89 = new URL('../../static/examples/tpcds/89.sql', import.meta.url);
const tpcds_q90 = new URL('../../static/examples/tpcds/90.sql', import.meta.url);
const tpcds_q91 = new URL('../../static/examples/tpcds/91.sql', import.meta.url);
const tpcds_q92 = new URL('../../static/examples/tpcds/92.sql', import.meta.url);
const tpcds_q93 = new URL('../../static/examples/tpcds/93.sql', import.meta.url);
const tpcds_q94 = new URL('../../static/examples/tpcds/94.sql', import.meta.url);
const tpcds_q95 = new URL('../../static/examples/tpcds/95.sql', import.meta.url);
const tpcds_q96 = new URL('../../static/examples/tpcds/96.sql', import.meta.url);
const tpcds_q97 = new URL('../../static/examples/tpcds/97.sql', import.meta.url);
const tpcds_q98 = new URL('../../static/examples/tpcds/98.sql', import.meta.url);

const ssb_schema = new URL('../../static/examples/ssb/schema.sql', import.meta.url);
const ssb_q11 = new URL('../../static/examples/ssb/q11.sql', import.meta.url);
const ssb_q12 = new URL('../../static/examples/ssb/q12.sql', import.meta.url);
const ssb_q13 = new URL('../../static/examples/ssb/q13.sql', import.meta.url);
const ssb_q21 = new URL('../../static/examples/ssb/q21.sql', import.meta.url);
const ssb_q22 = new URL('../../static/examples/ssb/q22.sql', import.meta.url);
const ssb_q23 = new URL('../../static/examples/ssb/q23.sql', import.meta.url);
const ssb_q31 = new URL('../../static/examples/ssb/q31.sql', import.meta.url);
const ssb_q32 = new URL('../../static/examples/ssb/q32.sql', import.meta.url);
const ssb_q33 = new URL('../../static/examples/ssb/q33.sql', import.meta.url);
const ssb_q34 = new URL('../../static/examples/ssb/q34.sql', import.meta.url);
const ssb_q41 = new URL('../../static/examples/ssb/q41.sql', import.meta.url);
const ssb_q42 = new URL('../../static/examples/ssb/q42.sql', import.meta.url);
const ssb_q43 = new URL('../../static/examples/ssb/q43.sql', import.meta.url);

export const TPCH_SCHEMA = createExampleMetadata('tpch_schema.sql', tpch_schema, null);
export const TPCH_QUERIES = [
    createExampleMetadata('tpch_q1.sql', tpch_q1, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q2.sql', tpch_q2, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q3.sql', tpch_q3, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q4.sql', tpch_q4, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q5.sql', tpch_q5, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q6.sql', tpch_q6, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q7.sql', tpch_q7, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q8.sql', tpch_q8, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q9.sql', tpch_q9, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q10.sql', tpch_q10, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q11.sql', tpch_q11, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q12.sql', tpch_q12, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q13.sql', tpch_q13, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q14.sql', tpch_q14, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q15.sql', tpch_q15, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q16.sql', tpch_q16, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q16.sql', tpch_q17, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q18.sql', tpch_q18, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q19.sql', tpch_q19, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q20.sql', tpch_q20, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q21.sql', tpch_q21, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpch_q22.sql', tpch_q22, TPCH_SCHEMA.scriptName),
];

export const TPCDS_SCHEMA = createExampleMetadata('tpcds_schema.sql', tpcds_schema, null);
export const TPCDS_QUERIES = [
    createExampleMetadata('tpcds_q1.sql', tpcds_q1, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q2.sql', tpcds_q2, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q3.sql', tpcds_q3, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q4.sql', tpcds_q4, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q5.sql', tpcds_q5, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q6.sql', tpcds_q6, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q7.sql', tpcds_q7, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q8.sql', tpcds_q8, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q9.sql', tpcds_q9, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q10.sql', tpcds_q10, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q11.sql', tpcds_q11, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q12.sql', tpcds_q12, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q13.sql', tpcds_q13, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q14a.sql', tpcds_q14a, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q14b.sql', tpcds_q14b, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q15.sql', tpcds_q15, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q16.sql', tpcds_q16, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q17.sql', tpcds_q17, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q18.sql', tpcds_q18, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q19.sql', tpcds_q19, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q20.sql', tpcds_q20, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q21.sql', tpcds_q21, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q22.sql', tpcds_q22, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q23a.sql', tpcds_q23a, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q23b.sql', tpcds_q23b, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q24a.sql', tpcds_q24a, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q24b.sql', tpcds_q24b, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q25.sql', tpcds_q25, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q26.sql', tpcds_q26, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q27.sql', tpcds_q27, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q28.sql', tpcds_q28, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q29.sql', tpcds_q29, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q30.sql', tpcds_q30, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q31.sql', tpcds_q31, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q32.sql', tpcds_q32, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q33.sql', tpcds_q33, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q34.sql', tpcds_q34, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q35.sql', tpcds_q35, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q36.sql', tpcds_q36, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q37.sql', tpcds_q37, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q38.sql', tpcds_q38, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q39a.sql', tpcds_q39a, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q39b.sql', tpcds_q39b, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q40.sql', tpcds_q40, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q41.sql', tpcds_q41, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q42.sql', tpcds_q42, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q43.sql', tpcds_q43, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q44.sql', tpcds_q44, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q45.sql', tpcds_q45, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q46.sql', tpcds_q46, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q47.sql', tpcds_q47, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q48.sql', tpcds_q48, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q49.sql', tpcds_q49, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q50.sql', tpcds_q50, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q51.sql', tpcds_q51, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q52.sql', tpcds_q52, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q53.sql', tpcds_q53, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q54.sql', tpcds_q54, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q55.sql', tpcds_q55, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q56.sql', tpcds_q56, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q57.sql', tpcds_q57, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q58.sql', tpcds_q58, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q59.sql', tpcds_q59, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q60.sql', tpcds_q60, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q61.sql', tpcds_q61, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q62.sql', tpcds_q62, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q63.sql', tpcds_q63, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q64.sql', tpcds_q64, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q65.sql', tpcds_q65, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q66.sql', tpcds_q66, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q67.sql', tpcds_q67, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q68.sql', tpcds_q68, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q69.sql', tpcds_q69, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q70.sql', tpcds_q70, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q71.sql', tpcds_q71, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q72.sql', tpcds_q72, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q73.sql', tpcds_q73, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q74.sql', tpcds_q74, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q75.sql', tpcds_q75, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q76.sql', tpcds_q76, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q77.sql', tpcds_q77, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q78.sql', tpcds_q78, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q79.sql', tpcds_q79, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q80.sql', tpcds_q80, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q81.sql', tpcds_q81, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q82.sql', tpcds_q82, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q83.sql', tpcds_q83, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q84.sql', tpcds_q84, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q85.sql', tpcds_q85, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q86.sql', tpcds_q86, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q87.sql', tpcds_q87, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q88.sql', tpcds_q88, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q89.sql', tpcds_q89, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q90.sql', tpcds_q90, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q91.sql', tpcds_q91, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q92.sql', tpcds_q92, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q93.sql', tpcds_q93, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q94.sql', tpcds_q94, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q95.sql', tpcds_q95, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q96.sql', tpcds_q96, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q97.sql', tpcds_q97, TPCH_SCHEMA.scriptName),
    createExampleMetadata('tpcds_q98.sql', tpcds_q98, TPCH_SCHEMA.scriptName),
];

export const SSB_SCHEMA = createExampleMetadata('ssb_schema.sql', ssb_schema, null);
export const SSB_QUERIES = [
    createExampleMetadata('ssb_q11.sql', ssb_q11, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q12.sql', ssb_q12, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q13.sql', ssb_q13, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q21.sql', ssb_q21, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q22.sql', ssb_q22, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q23.sql', ssb_q23, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q31.sql', ssb_q31, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q32.sql', ssb_q32, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q33.sql', ssb_q33, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q34.sql', ssb_q34, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q41.sql', ssb_q41, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q42.sql', ssb_q42, SSB_SCHEMA.scriptName),
    createExampleMetadata('ssb_q43.sql', ssb_q43, SSB_SCHEMA.scriptName),
];

export interface SchemaScriptCollection {
    name: string;
    schema: ExampleScript;
    queries: ExampleScript[];
}

interface ExampleSchemas {
    TPCH: SchemaScriptCollection;
    TPCDS: SchemaScriptCollection;
    SSB: SchemaScriptCollection;
}

export const EXAMPLES: ExampleSchemas = {
    TPCH: {
        name: "TPC-H",
        schema: TPCH_SCHEMA,
        queries: TPCH_QUERIES,
    },
    TPCDS: {
        name: "TPC-DS",
        schema: TPCDS_SCHEMA,
        queries: TPCDS_QUERIES
    },
    SSB: {
        name: "SSB",
        schema: SSB_SCHEMA,
        queries: SSB_QUERIES
    }
};

export const EXAMPLE_SCHEMAS = [
    EXAMPLES.TPCH,
    EXAMPLES.TPCDS,
    EXAMPLES.SSB,
];

const stress_catalog_1_1_40 = new URL('../../static/examples/stress/catalog_1_1_40_schema.sql', import.meta.url);
const stress_catalog_1_1_40_query = new URL('../../static/examples/stress/catalog_1_1_40_query.sql', import.meta.url);

export const STRESS_CATALOG_1_1_40_SCHEMA = createExampleMetadata('stress_catalog_1_1_40_schema.sql', stress_catalog_1_1_40, null);
export const STRESS_CATALOG_1_1_40_QUERY = createExampleMetadata('stress_catalog_1_1_40_query.sql', stress_catalog_1_1_40_query, STRESS_CATALOG_1_1_40_SCHEMA.scriptName);

export const STRESS_TESTS: SchemaScriptCollection[] = [
    {
        name: "Catalog 1_1_40",
        schema: STRESS_CATALOG_1_1_40_SCHEMA,
        queries: [STRESS_CATALOG_1_1_40_QUERY]
    }
];
