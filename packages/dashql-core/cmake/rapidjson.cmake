include(ExternalProject)

ExternalProject_Add(
    rapidjson_ep
    GIT_REPOSITORY "https://github.com/Tencent/rapidjson.git"
    GIT_TAG f54b0e4
    PREFIX "external_rapidjson"
    INSTALL_DIR "external_rapidjson/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_rapidjson/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_FLAGS=-std=c++20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_MODULE_PATH=${CMAKE_MODULE_PATH}
        -DCMAKE_BUILD_TYPE=Release
        -DRAPIDJSON_BUILD_DOC=FALSE
        -DRAPIDJSON_BUILD_EXAMPLES=FALSE
        -DRAPIDJSON_BUILD_TESTS=FALSE
        -DRAPIDJSON_BUILD_THIRDPARTY_GTEST=FALSE
)

# Prepare json
ExternalProject_Get_Property(rapidjson_ep install_dir)
set(RAPIDJSON_INCLUDE_DIR ${install_dir}/include)
file(MAKE_DIRECTORY ${RAPIDJSON_INCLUDE_DIR})
add_library(rapidjson INTERFACE)
target_include_directories(rapidjson SYSTEM INTERFACE ${RAPIDJSON_INCLUDE_DIR})

# Dependencies
add_dependencies(rapidjson rapidjson_ep)

