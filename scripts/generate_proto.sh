#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

FLATC="flatc"
${FLATC} --version \
    && { echo "[ OK  ] Command: flatc"; } \
    || { echo "[ ERR ] Command: flatc"; exit 1; }

SPEC_DIR="${PROJECT_ROOT}/proto/"
SPEC_INDEX="${SPEC_DIR}/flatsql/proto.fbs"

OUT_DIR_CPP="${PROJECT_ROOT}/packages/flatsql-proto-cpp/include/flatsql/proto"
OUT_DIR_TS="${PROJECT_ROOT}/packages/flatsql-proto-es/src/"
OUT_DIR_RS="${PROJECT_ROOT}/packages/flatsql-proto-rs/src/"

mkdir -p ${OUT_DIR_CPP} ${OUT_DIR_TS}

${FLATC} -I ${SPEC_DIR} -o ${OUT_DIR_CPP} ${SPEC_INDEX} --cpp \
        --gen-all \
        --no-prefix --scoped-enums \
        --reflect-types --reflect-names \
        --gen-object-api --gen-name-strings --gen-compare \
        --gen-mutable \
    && { echo "[ OK  ] Generate C++ Library"; } \
    || { echo "[ ERR ] Generate C++ Library"; exit 1; }

${FLATC} -I ${SPEC_DIR} -o ${OUT_DIR_RS} ${SPEC_INDEX} --rust \
        --gen-all \
        --gen-object-api --gen-name-strings \
    && { echo "[ OK  ] Generate Rust Library"; } \
    || { echo "[ ERR ] Generate Rust Library"; exit 1; }

${FLATC} -I ${SPEC_DIR} -o ${OUT_DIR_TS} ${SPEC_INDEX} --ts \
        --gen-all \
        --reflect-types --reflect-names \
        --gen-name-strings --gen-compare \
        --gen-mutable \
    && { echo "[ OK  ] Generate Typescript Library"; } \
    || { echo "[ ERR ] Generate Typescript Library"; exit 1; }


TS_OUT_PROTO_BASE="${PROJECT_ROOT}/packages/flatsql-proto-es/src/flatsql/proto/"
TS_OUT_PROTO_DIRS=`ls ${TS_OUT_PROTO_BASE}/`
rm "${TS_OUT_PROTO_BASE}/../proto.ts"

PROTO_INDEX="${TS_OUT_PROTO_BASE}/index.ts"
echo "Generating $PROTO_INDEX"
echo > ${PROTO_INDEX}
PROTO_FILES=`ls ${TS_OUT_PROTO_BASE}/*.ts`
for PROTO_FILE in ${PROTO_FILES}; do
    IMPORT="$(basename $PROTO_FILE)"
    if [ "${IMPORT}" = "index.ts" ]; then continue; fi
    echo "export * from \"./${IMPORT%.*}\";" >> ${PROTO_INDEX}
done
