include(ExternalProject)

ExternalProject_Add(
    ankerl_ep
    GIT_REPOSITORY "https://github.com/martinus/unordered_dense.git"
    GIT_TAG 3add2a6
    TIMEOUT 10
    PREFIX "external_ankerl"
    INSTALL_DIR "external_ankerl/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DWASI_SDK_PREFIX=${WASI_SDK_PREFIX}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_ankerl/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_SYSROOT=${CMAKE_SYSROOT}
        -DCMAKE_BUILD_TYPE=Release
)

ExternalProject_Get_Property(ankerl_ep install_dir)
set(ANKERL_INCLUDE_DIR ${install_dir}/include)
add_library(ankerl INTERFACE)
target_include_directories(ankerl INTERFACE ${ANKERL_INCLUDE_DIR})
add_dependencies(ankerl ankerl_ep)
file(MAKE_DIRECTORY ${ANKERL_INCLUDE_DIR})
