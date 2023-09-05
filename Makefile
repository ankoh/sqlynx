.DEFAULT_GOAL := lib

# ---------------------------------------------------------------------------
# Config

ROOT_DIR:=$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

UID=${shell id -u}
GID=${shell id -g}

LIB_SOURCE_DIR="${ROOT_DIR}/packages/flatsql"
LIB_DEBUG_DIR="${LIB_SOURCE_DIR}/build/native/o0"
LIB_RELWITHDEBINFO_DIR="${LIB_SOURCE_DIR}/build/native/o2"
LIB_RELEASE_DIR="${LIB_SOURCE_DIR}/build/native/o3"
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

.PHONY: lib_o0
lib_o0:
	mkdir -p ${LIB_DEBUG_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_DEBUG_DIR} \
		-DCMAKE_BUILD_TYPE=Debug \
		-DCMAKE_EXPORT_COMPILE_COMMANDS=1
	ln -sf ${LIB_DEBUG_DIR}/compile_commands.json ${LIB_SOURCE_DIR}/compile_commands.json
	cmake --build ${LIB_DEBUG_DIR} --parallel ${CORES}

.PHONY: lib_o0
lib_o0_cov:
	mkdir -p ${LIB_DEBUG_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_DEBUG_DIR} \
		-DCODE_COVERAGE=1 \
		-DCMAKE_BUILD_TYPE=Debug \
		-DCMAKE_EXPORT_COMPILE_COMMANDS=1
	ln -sf ${LIB_DEBUG_DIR}/compile_commands.json ${LIB_SOURCE_DIR}/compile_commands.json
	cmake --build ${LIB_DEBUG_DIR} --parallel ${CORES}

.PHONY: lib_o2
lib_o2:
	mkdir -p ${LIB_RELWITHDEBINFO_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_RELWITHDEBINFO_DIR} -DCMAKE_BUILD_TYPE=RelWithDebInfo
	cmake --build ${LIB_RELWITHDEBINFO_DIR} --parallel ${CORES}

.PHONY: lib_o3
lib_o3:
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

.PHONY: cursor_tests
cursor_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*ScannerTest*:*ParserTest*:*CursorTest*"

.PHONY: scanner_tests
scanner_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Scanner*"

.PHONY: parser_tests
parser_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Parser*"

.PHONY: analyzer_tests
analyzer_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Analyzer*"

.PHONY: rope_tests
rope_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Rope*"

.PHONY: graph_tests
graph_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*SchemaGraphTest*"

.PHONY: completion_tests
completion_tests:
	${LIB_DEBUG_DIR}/tester --source_dir . --gtest_filter="*Suffix*"

.PHONY: benchmark_steps
benchmark_steps:
	${LIB_RELWITHDEBINFO_DIR}/bm_steps

.PHONY: benchmark_layout
benchmark_layout:
	${LIB_RELWITHDEBINFO_DIR}/bm_layout

.PHONY: wasm_o0
wasm_o0:
	./scripts/build_parser_wasm.sh o0

.PHONY: wasm_o2
wasm_o2:
	./scripts/build_parser_wasm.sh o2

.PHONY: wasm_o3
wasm_o3:
	./scripts/build_parser_wasm.sh o3

.PHONY: jslib_o0
jslib_o0:
	yarn workspace @ankoh/flatsql build:o0

.PHONY: jslib_o2
jslib_o2:
	yarn workspace @ankoh/flatsql build:o2

.PHONY: jslib_o3
jslib_o3:
	yarn workspace @ankoh/flatsql build:o3

.PHONY: jslib_tests
jslib_tests:
	yarn workspace @ankoh/flatsql test

.PHONY: editor_o3
editor_o3:
	yarn workspace @ankoh/flatsql-editor pwa:build:o3

.PHONY: editor_start
editor_start:
	yarn workspace @ankoh/flatsql-editor pwa:start

.PHONY: lsp
lsp:
	yarn workspace @ankoh/flatsql-lsp build

.PHONY: vscode
vscode:
	yarn workspace flatsql-vscode build

.PHONY: vscode_package
vscode_package:
	yarn workspace flatsql-vscode package

.PHONY: parser_dumps
parser_dumps:
	${LIB_DEBUG_DIR}/dump_parser --source_dir .

.PHONY: analyzer_dumps
analyzer_dumps:
	${LIB_DEBUG_DIR}/dump_analyzer --source_dir .
