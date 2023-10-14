include(ExternalProject)

ExternalProject_Add(
    frozen_ep
    GIT_REPOSITORY "https://github.com/serge-sans-paille/frozen"
    GIT_TAG c241d64
    TIMEOUT 10
    PREFIX "external_frozen"
    INSTALL_DIR "external_frozen/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DWASI_SDK_PREFIX=${WASI_SDK_PREFIX}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_frozen/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_SYSROOT=${CMAKE_SYSROOT}
        -DCMAKE_BUILD_TYPE=Release
        -Dfrozen.tests=OFF
        -Dfrozen.benchmark=OFF
        -Dfrozen.coverage=OFF
)

ExternalProject_Get_Property(frozen_ep install_dir)
set(FROZEN_INCLUDE_DIR ${install_dir}/include)
add_library(frozen INTERFACE)
target_include_directories(frozen INTERFACE ${FROZEN_INCLUDE_DIR})
add_dependencies(frozen frozen_ep)
file(MAKE_DIRECTORY ${FROZEN_INCLUDE_DIR})
