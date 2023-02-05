#!/usr/bin/env bash

set -euo pipefail

trap exit SIGINT

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

MODE=${1:-Fast}
echo "MODE=${MODE}"

CPP_SOURCE_DIR="${PROJECT_ROOT}/packages/flatsql-parser"
CPP_BUILD_DIR="${CPP_SOURCE_DIR}/build/wasm/${MODE}"

CORES=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu)

ADDITIONAL_FLAGS=
case $MODE in
  "Debug") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=Debug" ;;
  "Fast") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=RelWithDebInfo" ;;
  "Release") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=Release" ;;
   *) ;;
esac
echo "BUILD_TYPE=${MODE}"
echo "WASI_SDK_PREFIX=${WASI_SDK_PREFIX}"
echo "WASI_TOOLCHAIN=${WASI_CMAKE_TOOLCHAIN}"

mkdir -p ${CPP_BUILD_DIR}

set -x
cmake \
    -S"${CPP_SOURCE_DIR}/" \
    -B"${CPP_BUILD_DIR}/" \
    -DWASI_SDK_PREFIX=${WASI_SDK_PREFIX} \
    -DCMAKE_SYSROOT=${WASI_SYSROOT} \
    -DCMAKE_TOOLCHAIN_FILE=${WASI_CMAKE_TOOLCHAIN} \
    -DWASM=1 \
    ${ADDITIONAL_FLAGS}

make \
    -C"${CPP_BUILD_DIR}" \
    -j${CORES} \
    flatsql_parser

if [ ${MODE} == "Release" ]; then
    wasm-opt -O3 -o ${CPP_BUILD_DIR}/flatsql_parser_opt.wasm ${CPP_BUILD_DIR}/flatsql_parser.wasm
    wasm-strip ${CPP_BUILD_DIR}/flatsql_parser_opt.wasm
    mv ${CPP_BUILD_DIR}/flatsql_parser_opt.wasm ${CPP_BUILD_DIR}/flatsql_parser.wasm
fi
