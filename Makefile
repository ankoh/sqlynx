.DEFAULT_GOAL := lib

# ---------------------------------------------------------------------------
# Config

ROOT_DIR:=$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

UID=${shell id -u}
GID=${shell id -g}

LIB_SOURCE_DIR="${ROOT_DIR}/packages/flatsql"
LIB_DEBUG_DIR="${LIB_SOURCE_DIR}/build/native/Debug"
LIB_RELEASE_DIR="${LIB_SOURCE_DIR}/build/native/Release"
LIB_RELWITHDEBINFO_DIR="${LIB_SOURCE_DIR}/build/native/RelWithDebInfo"
LIB_COVERAGE_DIR="${LIB_SOURCE_DIR}/build/coverage"

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

.PHONY: infra_linux
infra_linux:
	./scripts/install_infra.sh linux

.PHONY: infra_macos
infra_macos:
	./scripts/install_infra.sh macos

.PHONY: proto
proto:
	./scripts/generate_proto.sh

.PHONY: lib
lib:
	mkdir -p ${LIB_DEBUG_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_DEBUG_DIR} \
		-DCODE_COVERAGE=1 \
		-DCMAKE_BUILD_TYPE=Debug \
		-DCMAKE_EXPORT_COMPILE_COMMANDS=1
	ln -sf ${LIB_DEBUG_DIR}/compile_commands.json ${LIB_SOURCE_DIR}/compile_commands.json
	cmake --build ${LIB_DEBUG_DIR} --parallel ${CORES}

.PHONY: lib_relwithdebinfo
lib_relwithdebinfo:
	mkdir -p ${LIB_RELWITHDEBINFO_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_RELWITHDEBINFO_DIR} -DCMAKE_BUILD_TYPE=RelWithDebInfo
	cmake --build ${LIB_RELWITHDEBINFO_DIR} --parallel ${CORES}

.PHONY: lib_release
lib_release:
	mkdir -p ${LIB_RELEASE_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_RELEASE_DIR} -DCMAKE_BUILD_TYPE=Release
	cmake --build ${LIB_RELEASE_DIR} --parallel ${CORES}

.PHONY: lib_tests
lib_tests:
	${LIB_DEBUG_DIR}/tester --source_dir .

.PHONY: lib_coverage
lib_coverage:
	${LLVM_PROFDATA} merge -output=default.prof -instr default.profraw
	${LLVM_COV} show \
		--instr-profile default.prof \
		--format html \
		--ignore-filename-regex='.*/build/native/Debug/.*' \
		--ignore-filename-regex='.*/utf8proc/.*' \
		--ignore-filename-regex='.*/proto/proto_generated.h' \
		--ignore-filename-regex='.*/.*\.list' \
		-o ${LIB_COVERAGE_DIR} \
		${LIB_DEBUG_DIR}/tester

.PHONY: parser_tests
parser_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Parser*"

.PHONY: analyzer_tests
analyzer_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Analyzer*"

.PHONY: rope_tests
rope_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Rope*"

.PHONY: completion_tests
completion_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Suffix*"

.PHONY: bm_parser
bm_parser:
	${LIB_RELWITHDEBINFO_DIR}/bm_parse_query

.PHONY: bm_analyzer
bm_analyzer:
	${LIB_RELWITHDEBINFO_DIR}/bm_analyze_query

.PHONY: wasm
wasm:
	./scripts/build_parser_wasm.sh Release

.PHONY: wasm_fast
wasm_fast:
	./scripts/build_parser_wasm.sh Fast

.PHONY: jslib
jslib:
	yarn workspace @ankoh/flatsql build:debug

.PHONY: jslib_release
jslib_release:
	yarn workspace @ankoh/flatsql build:release

.PHONY: jslib_tests
jslib_tests:
	yarn workspace @ankoh/flatsql test

.PHONY: canvas_start
canvas_start:
	yarn workspace @ankoh/flatsql-canvas pwa:start

.PHONY: parser_dumps
parser_dumps:
	${LIB_DEBUG_DIR}/dump_parser --source_dir .

.PHONY: analyzer_dumps
analyzer_dumps:
	${LIB_DEBUG_DIR}/dump_analyzer --source_dir .

.PHONY: printer_dumps
printer_dumps:
	${LIB_DEBUG_DIR}/dump_analyzer --source_dir .
