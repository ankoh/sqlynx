find_package(Git)
if(Git_FOUND)
    if (NOT DEFINED GIT_COMMIT_HASH)
        execute_process(
                COMMAND ${GIT_EXECUTABLE} log -1 --format=%h
                WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
                RESULT_VARIABLE GIT_RESULT
                OUTPUT_VARIABLE GIT_COMMIT_HASH
                OUTPUT_STRIP_TRAILING_WHITESPACE)
    endif()
    execute_process(
            COMMAND ${GIT_EXECUTABLE} describe --tags --abbrev=0
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
            OUTPUT_VARIABLE GIT_LAST_TAG
            OUTPUT_STRIP_TRAILING_WHITESPACE)
    execute_process(
            COMMAND ${GIT_EXECUTABLE} describe --tags --long
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
            OUTPUT_VARIABLE GIT_ITERATION
            OUTPUT_STRIP_TRAILING_WHITESPACE)
else()
    message("Git NOT FOUND")
endif()

if(GIT_RESULT EQUAL "0")
    string(REGEX REPLACE "([0-9]+).[0-9]+.[0-9]+" "\\1" FLATSQL_VERSION_MAJOR "${GIT_LAST_TAG}")
    string(REGEX REPLACE "[0-9]+.([0-9]+).[0-9]+" "\\1" FLATSQL_VERSION_MINOR "${GIT_LAST_TAG}")
    string(REGEX REPLACE "[0-9]+.[0-9]+.([0-9]+)" "\\1" FLATSQL_VERSION_PATCH "${GIT_LAST_TAG}")
    string(REGEX REPLACE ".*-([0-9]+)-.*" "\\1" FLATSQL_VERSION_DEV "${GIT_ITERATION}")

    if(FLATSQL_VERSION_DEV EQUAL 0)
        set(FLATSQL_VERSION "${GIT_LAST_TAG}")
    else()
        math(EXPR FLATSQL_VERSION_PATCH "${FLATSQL_VERSION_PATCH}+1")
        set(FLATSQL_VERSION "${FLATSQL_VERSION_MAJOR}.${FLATSQL_VERSION_MINOR}.${FLATSQL_VERSION_PATCH}-dev${FLATSQL_VERSION_DEV}")
    endif()
else()
    set(FLATSQL_VERSION_MAJOR 0)
    set(FLATSQL_VERSION_MINOR 0)
    set(FLATSQL_VERSION_PATCH 1)
    set(FLATSQL_VERSION_DEV 0)
    set(FLATSQL_VERSION "${FLATSQL_VERSION_MAJOR}.${FLATSQL_VERSION_MINOR}.${FLATSQL_VERSION_PATCH}-dev${FLATSQL_VERSION_DEV}")
endif()

message(STATUS "git hash ${GIT_COMMIT_HASH}, version ${FLATSQL_VERSION}")

configure_file(${CMAKE_SOURCE_DIR}/cmake/version.cc.tpl "${CMAKE_BINARY_DIR}/version.cc" @ONLY)
add_library(sqlynx_version ${CMAKE_BINARY_DIR}/version.cc)
