#!/usr/bin/env bash

set -exuo pipefail

trap exit SIGINT

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

INFRA_DIR="${PROJECT_ROOT}/.infra"
INFRA_DOWNLOAD="${PROJECT_ROOT}/.infra/download"
INFRA_UNPACKED="${PROJECT_ROOT}/.infra/unpacked"

WASI_VERSION=19
WASI_VERSION_FULL=${WASI_VERSION}.0
WABT_VERSION=1.0.32
BINARYEN_VERSION=111

WASI_URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VERSION}/wasi-sdk-${WASI_VERSION_FULL}-macos.tar.gz"
WABT_URL="https://github.com/WebAssembly/wabt/releases/download/${WABT_VERSION}/wabt-${WABT_VERSION}-macos-12.tar.gz"
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-macos.tar.gz"
FLATC_URL="https://github.com/google/flatbuffers/releases/download/v23.1.21/Mac.flatc.binary.zip"

mkdir -p "${INFRA_DOWNLOAD}"

if [ ! -e "${INFRA_DOWNLOAD}/wasi.zip" ]; then
    curl -Lo "${INFRA_DOWNLOAD}/wasi.zip" ${WASI_URL}
fi
if [ ! -e "${INFRA_DOWNLOAD}/wabt.zip" ]; then
    curl -Lo "${INFRA_DOWNLOAD}/wabt.zip" ${WABT_URL}
fi
if [ ! -e "${INFRA_DOWNLOAD}/binaryen.zip" ]; then
    curl -Lo "${INFRA_DOWNLOAD}/binaryen.zip" ${BINARYEN_URL}
fi
if [ ! -e "${INFRA_DOWNLOAD}/flatc.zip" ]; then
    curl -Lo "${INFRA_DOWNLOAD}/flatc.zip" ${FLATC_URL}
fi

rm -rf "${INFRA_UNPACKED}"
mkdir -p "${INFRA_UNPACKED}"

mkdir -p "${INFRA_UNPACKED}/wasi"
tar xf "${INFRA_DOWNLOAD}/wasi.zip" -C "${INFRA_UNPACKED}/wasi" --strip-components 1

mkdir -p "${INFRA_UNPACKED}/wabt"
tar xf "${INFRA_DOWNLOAD}/wabt.zip" -C "${INFRA_UNPACKED}/wabt" --strip-components 1

mkdir -p "${INFRA_UNPACKED}/binaryen"
tar xf "${INFRA_DOWNLOAD}/binaryen.zip" -C "${INFRA_UNPACKED}/binaryen" --strip-components 1

mkdir -p "${INFRA_UNPACKED}/flatc"
unzip "${INFRA_DOWNLOAD}/flatc.zip" -d "${INFRA_UNPACKED}/flatc"