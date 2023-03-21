if(POLICY CMP0048)
  cmake_policy(SET CMP0048 NEW)
endif(POLICY CMP0048)

project(flatsql_parser VERSION 0.1)
cmake_minimum_required(VERSION 3.10)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS -std=c++20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ---------------------------------------------------------------------------
# Parallelism

include(ProcessorCount)
ProcessorCount(NPROCS)
set(CMAKE_BUILD_PARALLEL_LEVEL ${NPROCS})

# ---------------------------------------------------------------------------
# WASM

if(WASM)
  if(CMAKE_BUILD_TYPE MATCHES Release)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Os")
  endif()
  set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
  set(CMAKE_CXX_FLAGS
      "${CMAKE_CXX_FLAGS} \
        -DWASM=1 \
        --target=wasm32-wasi \
        -fno-exceptions \
        ")
  set(CMAKE_EXE_LINKER_FLAGS
      "${CMAKE_EXE_LINKER_FLAGS} \
        -Wl,--export=flatsql_parse \
        -Wl,--export=flatsql_new_result \
        -Wl,--export=flatsql_new_string \
        -Wl,--export=flatsql_delete_result \
        -Wl,--export=flatsql_delete_string \
        -flto \
    ")
endif()

# ---------------------------------------------------------------------------
# CMake includes

set(CMAKE_MODULE_PATH ${CMAKE_SOURCE_DIR}/cmake/modules ${CMAKE_MODULE_PATH})
include(${CMAKE_SOURCE_DIR}/cmake/flatbuffers.cmake)
add_subdirectory(${CMAKE_SOURCE_DIR}/vendor/utf8proc)

if(NOT WASM)
  find_package(Threads REQUIRED)
  include(${CMAKE_SOURCE_DIR}/cmake/gtest.cmake)
  include(${CMAKE_SOURCE_DIR}/cmake/gflags.cmake)
  include(${CMAKE_SOURCE_DIR}/cmake/benchmark.cmake)
  include(${CMAKE_SOURCE_DIR}/cmake/pugixml.cmake)
endif()

include_directories("${CMAKE_SOURCE_DIR}/include" "${CMAKE_BINARY_DIR}/include")

# ---------------------------------------------------------------------------
# Parser

set(REQUIRED_BISON_VERSION 3.7)

# If Bison has been installed via homebrew, prefer this installation.
find_program(BREW_BIN brew)
if(BREW_BIN)
  execute_process(
    COMMAND ${BREW_BIN} --prefix bison
    OUTPUT_VARIABLE BISON_PREFIX
    OUTPUT_STRIP_TRAILING_WHITESPACE)
  set(BISON_EXECUTABLE "${BISON_PREFIX}/bin/bison")
  find_package(BISON ${REQUIRED_BISON_VERSION})
endif()

if(NOT BISON_FOUND)
  find_package(BISON ${REQUIRED_BISON_VERSION})
endif()

if(NOT BISON_FOUND)
  message(FATAL_ERROR "Could not find bison")
endif()

find_package(FLEX REQUIRED)

set(GRAMMAR_SOURCE_DIR ${CMAKE_SOURCE_DIR}/../../grammar/)

set(GRAMMAR_OUT ${CMAKE_BINARY_DIR}/flatsql.y)
set(GRAMMAR_DELIMITER ${GRAMMAR_SOURCE_DIR}/delimiter.y)
set(GRAMMAR_PROLOGUE ${GRAMMAR_SOURCE_DIR}/prologue.y)
set(GRAMMAR_EPILOGUE ${GRAMMAR_SOURCE_DIR}/epilogue.y)
set(GRAMMAR_PRECEDENCES ${GRAMMAR_SOURCE_DIR}/precedences.y)

set(GRAMMAR_KEYWORDS
    ${GRAMMAR_SOURCE_DIR}/lists/sql_column_name_keywords.list
    ${GRAMMAR_SOURCE_DIR}/lists/sql_reserved_keywords.list
    ${GRAMMAR_SOURCE_DIR}/lists/sql_type_func_keywords.list
    ${GRAMMAR_SOURCE_DIR}/lists/sql_unreserved_keywords.list)

set(GRAMMAR_RULES
    ${GRAMMAR_SOURCE_DIR}/rules/sql_create.y
    ${GRAMMAR_SOURCE_DIR}/rules/sql_select.y
    ${GRAMMAR_SOURCE_DIR}/rules/sql_view.y
    ${GRAMMAR_SOURCE_DIR}/rules/ext_statement.y
    ${GRAMMAR_SOURCE_DIR}/rules/ext_set.y
    ${GRAMMAR_SOURCE_DIR}/rules/ext_varargs.y)

set(GRAMMAR_TYPES
    ${GRAMMAR_SOURCE_DIR}/rules/sql_create.yh
    ${GRAMMAR_SOURCE_DIR}/rules/sql_select.yh
    ${GRAMMAR_SOURCE_DIR}/rules/sql_view.yh
    ${GRAMMAR_SOURCE_DIR}/rules/ext_statement.yh
    ${GRAMMAR_SOURCE_DIR}/rules/ext_set.yh
    ${GRAMMAR_SOURCE_DIR}/rules/ext_varargs.yh)

# Build grammar file
add_custom_command(
  OUTPUT ${GRAMMAR_OUT}
  COMMAND rm -f ${GRAMMAR_OUT}
  # DECLARATIONS
  # ------------------------------------------------
  # Write the prologue
  COMMAND cat ${GRAMMAR_PROLOGUE} >> ${GRAMMAR_OUT}
  # Write the keyword token definitions Output: %token FILE1_KEYWORD1
  # FILE1_KEYWORD2 %token FILE2_KEYWORD1 FILE2_KEYWORD2
  COMMAND
    awk -F,
    "{t=substr($3, 1, length($3)-1); if (FNR == 1) { printf \"\\n%%token \" t } else { printf t }} END {print \"\\n\"}"
    ${GRAMMAR_KEYWORDS} >> ${GRAMMAR_OUT}
  # Write precedence rules
  COMMAND cat ${GRAMMAR_PRECEDENCES} >> ${GRAMMAR_OUT}
  # Write token types
  COMMAND cat ${GRAMMAR_TYPES} >> ${GRAMMAR_OUT}
  # RULES
  # ------------------------------------------------
  COMMAND echo "%%" >> ${GRAMMAR_OUT}
  # Write the keyword bison rules Output: file1: FILE1_KEYWORD1 |
  # FILE1_KEYWORD2; file2: FILE2_KEYWORD1 | FILE2_KEYWORD2;
  COMMAND
    awk -F,
    "{n = split(FILENAME, p, \"/\"); bn=p[n]; bn=substr(bn, 1, length(bn)-5); t=substr($3, 1, length($3) - 1); if (NR == 1 && FNR == 1) {printf \"\\n\" bn \":\" t} else if (FNR == 1) {printf \";\\n\" bn \":\" t} else {printf \"|\" t}} END {printf \";\\n\\n\"}"
    ${GRAMMAR_KEYWORDS} >> ${GRAMMAR_OUT}
  # Write all the grammar rules
  COMMAND cat ${GRAMMAR_RULES} >> ${GRAMMAR_OUT}
  # CODE
  # ------------------------------------------------
  COMMAND echo "%%" >> ${GRAMMAR_OUT}
  # Write the epilogue
  COMMAND cat ${GRAMMAR_EPILOGUE} >> ${GRAMMAR_OUT}
  VERBATIM
  DEPENDS ${GRAMMAR_KEYWORDS} ${GRAMMAR_PROLOGUE} ${GRAMMAR_PRECEDENCES}
          ${GRAMMAR_TYPES} ${GRAMMAR_RULES} ${GRAMMAR_EPILOGUE})

set(SCANNER_OUT ${CMAKE_BINARY_DIR}/include/flatsql/parser/scanner.cc)
set(PARSER_OUT ${CMAKE_BINARY_DIR}/include/flatsql/parser/parser.cc)
set(PARSER_HEADER_OUT ${CMAKE_BINARY_DIR}/include/flatsql/parser/parser.h)

if(NOT EXISTS ${CMAKE_BINARY_DIR}/include/flatsql/parser/)
  file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/include/flatsql/parser/)
endif()

# Generate parser & scanner
add_custom_command(
  OUTPUT ${SCANNER_OUT} ${PARSER_OUT} ${PARSER_HEADER_OUT}
  COMMAND
    ${BISON_EXECUTABLE} --defines=${PARSER_HEADER_OUT} --output=${PARSER_OUT}
    --report=state --report-file=${CMAKE_BINARY_DIR}/bison.log ${GRAMMAR_OUT}
  COMMAND ${FLEX_EXECUTABLE} --outfile=${SCANNER_OUT}
          ${GRAMMAR_SOURCE_DIR}/scanner.l
  DEPENDS ${GRAMMAR_OUT} ${GRAMMAR_SOURCE_DIR}/scanner.l)

# ---------------------------------------------------------------------------
# Module

set(LIB_SRC
    ${SCANNER_OUT}
    ${PARSER_OUT}
    ${CMAKE_SOURCE_DIR}/src/parser/ffi.cc
    ${CMAKE_SOURCE_DIR}/src/parser/enums.cc
    ${CMAKE_SOURCE_DIR}/src/parser/highlighting.cc
    ${CMAKE_SOURCE_DIR}/src/parser/keywords.cc
    ${CMAKE_SOURCE_DIR}/src/parser/parser_driver.cc
    ${CMAKE_SOURCE_DIR}/src/parser/scanner.cc)

if(WASM)
  add_executable(flatsql_parser ${LIB_SRC})
else()
  add_library(flatsql_parser ${LIB_SRC})
endif()

target_link_libraries(flatsql_parser flatbuffers utf8proc)

# ---------------------------------------------------------------------------
# Tester

if(NOT WASM)
  add_library(flatsql_parser_testutils
    ${CMAKE_SOURCE_DIR}/src/testing/astdump_test.cc
  )
  target_link_libraries(flatsql_parser_testutils flatsql_parser pugixml gtest)

  set(TEST_SRC
    ${CMAKE_SOURCE_DIR}/test/astdump_test_suite.cc
    ${CMAKE_SOURCE_DIR}/test/append_buffer_test.cc
    ${CMAKE_SOURCE_DIR}/test/rope_test.cc
  )
  add_executable(tester test/tester.cc ${TEST_SRC})
  target_link_libraries(tester flatsql_parser flatsql_parser_testutils pugixml gtest gmock gflags Threads::Threads)

  add_executable(astdump tools/astdump.cc)
  target_link_libraries(astdump flatsql_parser flatsql_parser_testutils pugixml gtest gflags Threads::Threads)

  add_executable(sql2tpl tools/sql2tpl.cc)
  target_link_libraries(sql2tpl flatsql_parser flatsql_parser_testutils pugixml gtest gflags Threads::Threads)
endif()
