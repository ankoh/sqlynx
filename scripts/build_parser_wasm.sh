#!/usr/bin/env bash

set -euo pipefail

trap exit SIGINT

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

MODE=${1:-Fast}
echo "MODE=${MODE}"

CORES=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu)

BUILD_TYPE="Release"
case $MODE in
  "o0") BUILD_TYPE="Debug" ;;
  "o2") BUILD_TYPE="RelWithDebInfo" ;;
  "o3") BUILD_TYPE="Release" ;;
   *) ;;
esac
ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=${BUILD_TYPE}"

CPP_SOURCE_DIR="${PROJECT_ROOT}/packages/flatsql"
CPP_BUILD_DIR="${CPP_SOURCE_DIR}/build/wasm/${MODE}"

INFRA_DIR="${PROJECT_ROOT}/.infra"
WASI_SDK_PREFIX=${WASI_SDK_PREFIX:-"${INFRA_DIR}/unpacked/wasi"}
WASI_SYSROOT=${WASI_SYSROOT:-"${INFRA_DIR}/unpacked/wasi/share/wasi-sysroot"}
WASI_CMAKE_TOOLCHAIN=${WASI_CMAKE_TOOLCHAIN:-"${INFRA_DIR}/unpacked/wasi/share/cmake/wasi-sdk.cmake"}
WABT_BIN=${WABT_BIN:-"${INFRA_DIR}/unpacked/wabt/bin"}
BINARYEN_BIN=${BINARYEN_BIN:-"${INFRA_DIR}/unpacked/binaryen/bin"}

echo "MODE=${MODE}"
echo "BUILD_TYPE=${MODE}"
echo "WASI_SDK_PREFIX=${WASI_SDK_PREFIX}"
echo "WASI_SYSROOT=${WASI_SYSROOT}"
echo "WASI_CMAKE_TOOLCHAIN=${WASI_CMAKE_TOOLCHAIN}"
echo "WABT_BIN=${WABT_BIN}"
echo "BINARYEN_BIN=${BINARYEN_BIN}"

mkdir -p ${CPP_BUILD_DIR}

rm -f ${CPP_BUILD_DIR}/flatsql.wasm

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
    flatsql

if [ ${MODE} == "Release" ]; then
    ${BINARYEN_BIN}/wasm-opt -O3 -o ${CPP_BUILD_DIR}/flatsql_opt.wasm ${CPP_BUILD_DIR}/flatsql.wasm
    ${WABT_BIN}/wasm-strip ${CPP_BUILD_DIR}/flatsql_opt.wasm
    mv ${CPP_BUILD_DIR}/flatsql_opt.wasm ${CPP_BUILD_DIR}/flatsql.wasm
fi
