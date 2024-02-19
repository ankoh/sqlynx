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
    string(REGEX REPLACE "v([0-9]+).[0-9]+.[0-9]+" "\\1" SQLYNX_VERSION_MAJOR "${GIT_LAST_TAG}")
    string(REGEX REPLACE "v[0-9]+.([0-9]+).[0-9]+" "\\1" SQLYNX_VERSION_MINOR "${GIT_LAST_TAG}")
    string(REGEX REPLACE "v[0-9]+.[0-9]+.([0-9]+)" "\\1" SQLYNX_VERSION_PATCH "${GIT_LAST_TAG}")
    string(REGEX REPLACE ".*-([0-9]+)-.*" "\\1" SQLYNX_VERSION_DEV "${GIT_ITERATION}")

    if(SQLYNX_VERSION_DEV EQUAL 0)
        set(SQLYNX_VERSION "${GIT_LAST_TAG}")
    else()
        math(EXPR SQLYNX_VERSION_PATCH "${SQLYNX_VERSION_PATCH}+1")
        set(SQLYNX_VERSION "${SQLYNX_VERSION_MAJOR}.${SQLYNX_VERSION_MINOR}.${SQLYNX_VERSION_PATCH}-dev.${SQLYNX_VERSION_DEV}")
    endif()
else()
    set(SQLYNX_VERSION_MAJOR 0)
    set(SQLYNX_VERSION_MINOR 0)
    set(SQLYNX_VERSION_PATCH 1)
    set(SQLYNX_VERSION_DEV 0)
    set(SQLYNX_VERSION "${SQLYNX_VERSION_MAJOR}.${SQLYNX_VERSION_MINOR}.${SQLYNX_VERSION_PATCH}-dev.${SQLYNX_VERSION_DEV}")
endif()

message(STATUS "git hash ${GIT_COMMIT_HASH}, version ${SQLYNX_VERSION}")

configure_file(${CMAKE_SOURCE_DIR}/cmake/version.cc.tpl "${CMAKE_BINARY_DIR}/version.cc" @ONLY)
add_library(sqlynx_version ${CMAKE_BINARY_DIR}/version.cc)
