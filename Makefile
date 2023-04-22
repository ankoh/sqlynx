.DEFAULT_GOAL := parser

# ---------------------------------------------------------------------------
# Config

ROOT_DIR:=$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

UID=${shell id -u}
GID=${shell id -g}

PARSER_SOURCE_DIR="${ROOT_DIR}/packages/flatsql"
PARSER_DEBUG_DIR="${PARSER_SOURCE_DIR}/build/native/Debug"
PARSER_RELEASE_DIR="${PARSER_SOURCE_DIR}/build/native/Release"
PARSER_RELWITHDEBINFO_DIR="${PARSER_SOURCE_DIR}/build/RelWithDebInfo"
PARSER_COVERAGE_DIR="${PARSER_SOURCE_DIR}/build/coverage"

CORES=$(shell grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu)

LLVM_PROFDATA=llvm-profdata
LLVM_COV=llvm-cov
OS := $(shell uname)
ifeq ($(OS),Darwin)
	LLVM_PROFDATA=/opt/homebrew/opt/llvm/bin/llvm-profdata
	LLVM_COV=/opt/homebrew/opt/llvm/bin/llvm-cov
endif

# ---------------------------------------------------------------------------
# Parser

.PHONY: infra
infra:
	./scripts/install_infra_macos.sh

.PHONY: proto
proto:
	./scripts/generate_proto.sh
	yarn workspace @ankoh/flatsql build

.PHONY: parser
parser:
	mkdir -p ${PARSER_DEBUG_DIR}
	cmake -S ${PARSER_SOURCE_DIR} -B ${PARSER_DEBUG_DIR} \
		-DCODE_COVERAGE=1 \
		-DCMAKE_BUILD_TYPE=Debug \
		-DCMAKE_EXPORT_COMPILE_COMMANDS=1
	ln -sf ${PARSER_DEBUG_DIR}/compile_commands.json ${PARSER_SOURCE_DIR}/compile_commands.json
	cmake --build ${PARSER_DEBUG_DIR}

.PHONY: parser_release
parser_release:
	mkdir -p ${PARSER_RELEASE_DIR}
	cmake -S ${PARSER_SOURCE_DIR} -B ${PARSER_RELEASE_DIR} -DCMAKE_BUILD_TYPE=Release
	cmake --build ${PARSER_RELEASE_DIR}

.PHONY: parser_tests
parser_tests:
	${PARSER_DEBUG_DIR}/tester --source_dir .

.PHONY: coverage
parser_coverage:
	${LLVM_PROFDATA} merge -output=default.prof -instr default.profraw
	${LLVM_COV} show \
		--instr-profile default.prof \
		--format html \
		--ignore-filename-regex='.*/build/native/Debug/.*' \
		-o ${PARSER_COVERAGE_DIR} \
		${PARSER_DEBUG_DIR}/tester

.PHONY: parser_wasm
parser_wasm:
	./scripts/build_parser_wasm.sh Release

.PHONY: parser_wasm
parser_wasm_fast:
	./scripts/build_parser_wasm.sh Fast

.PHONY: jslib
jslib:
	yarn workspace @ankoh/flatsql build

.PHONY: demo_start
demo_start:
	yarn workspace @ankoh/flatsql-demo pwa:start

.PHONY: astdump
astdumps:
	${PARSER_DEBUG_DIR}/astdump --source_dir .
