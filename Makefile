.DEFAULT_GOAL := parser

# ---------------------------------------------------------------------------
# Config

ROOT_DIR:=$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

UID=${shell id -u}
GID=${shell id -g}

LIB_SOURCE_DIR="${ROOT_DIR}/packages/flatsql"
LIB_DEBUG_DIR="${LIB_SOURCE_DIR}/build/native/Debug"
LIB_RELEASE_DIR="${LIB_SOURCE_DIR}/build/native/Release"
LIB_RELWITHDEBINFO_DIR="${LIB_SOURCE_DIR}/build/RelWithDebInfo"
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

.PHONY: infra
infra:
	./scripts/install_infra_macos.sh

.PHONY: proto
proto:
	./scripts/generate_proto.sh
	yarn workspace @ankoh/flatsql build

.PHONY: lib
lib:
	mkdir -p ${LIB_DEBUG_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_DEBUG_DIR} \
		-DCODE_COVERAGE=1 \
		-DCMAKE_BUILD_TYPE=Debug \
		-DCMAKE_EXPORT_COMPILE_COMMANDS=1
	ln -sf ${LIB_DEBUG_DIR}/compile_commands.json ${LIB_SOURCE_DIR}/compile_commands.json
	cmake --build ${LIB_DEBUG_DIR}

.PHONY: lib_release
lib_release:
	mkdir -p ${LIB_RELEASE_DIR}
	cmake -S ${LIB_SOURCE_DIR} -B ${LIB_RELEASE_DIR} -DCMAKE_BUILD_TYPE=Release
	cmake --build ${LIB_RELEASE_DIR}

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

.PHONY: wasm
wasm:
	./scripts/build_parser_wasm.sh Release

.PHONY: wasm_fast
wasm_fast:
	./scripts/build_parser_wasm.sh Fast

.PHONY: jslib
jslib:
	yarn workspace @ankoh/flatsql build

.PHONY: demo_start
demo_start:
	yarn workspace @ankoh/flatsql-demo pwa:start

.PHONY: astdump
astdumps:
	${LIB_DEBUG_DIR}/astdump --source_dir .
