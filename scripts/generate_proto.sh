#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

FLATC=${FLATC:-"./.infra/unpacked/flatc/flatc"}
if ! [ -x "$(command -v ${FLATC})" ]; then
    FLATC="flatc"
fi
${FLATC} --version \
    && { echo "[ OK  ] Command: flatc"; } \
    || { echo "[ ERR ] Command: flatc"; exit 1; }

SPEC_DIR="${PROJECT_ROOT}/proto/"
SPEC_INDEX="${SPEC_DIR}/sqlynx/proto.fbs"

OUT_DIR_CPP="${PROJECT_ROOT}/packages/sqlynx/include/sqlynx/proto"
OUT_DIR_TS="${PROJECT_ROOT}/packages/sqlynx-wasm/gen"

rm -rf ${OUT_DIR_CPP}/*
rm -rf ${OUT_DIR_TS}/*
mkdir -p ${OUT_DIR_CPP} ${OUT_DIR_TS}

${FLATC} -I ${SPEC_DIR} -o ${OUT_DIR_CPP} ${SPEC_INDEX} --cpp \
        --gen-all \
        --no-prefix --scoped-enums \
        --reflect-types --reflect-names \
        --gen-object-api --gen-name-strings --gen-compare \
        --gen-mutable \
    && { echo "[ OK  ] Generate C++ Library"; } \
    || { echo "[ ERR ] Generate C++ Library"; exit 1; }

${FLATC} -I ${SPEC_DIR} -o ${OUT_DIR_TS} ${SPEC_INDEX} --ts \
        --gen-all \
        --reflect-types --reflect-names \
        --gen-name-strings --gen-compare \
        --gen-mutable \
        --gen-object-api \
        --ts-no-import-ext \
    && { echo "[ OK  ] Generate Typescript Library"; } \
    || { echo "[ ERR ] Generate Typescript Library"; exit 1; }


TS_OUT_PROTO_BASE="${OUT_DIR_TS}/sqlynx/proto"
TS_OUT_PROTO_DIRS=`ls ${TS_OUT_PROTO_BASE}/`
TS_OUT_PROTO_IDX="${TS_OUT_PROTO_BASE}/../proto.ts"
if [ -f ${TS_OUT_PROTO_IDX} ]; then
    rm ${TS_OUT_PROTO_IDX}
fi

PROTO_INDEX="${TS_OUT_PROTO_BASE}/index.ts"
echo "Generating $PROTO_INDEX"
echo > ${PROTO_INDEX}
PROTO_FILES=`ls ${TS_OUT_PROTO_BASE}/*.ts`
for PROTO_FILE in ${PROTO_FILES}; do
    IMPORT="$(basename $PROTO_FILE)"
    if [ "${IMPORT}" = "index.ts" ]; then continue; fi
    echo "export * from \"./${IMPORT%.*}\";" >> ${PROTO_INDEX}
done
