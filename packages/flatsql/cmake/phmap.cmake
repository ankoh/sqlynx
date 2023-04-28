include(ExternalProject)

ExternalProject_Add(
    phmap_ep
    GIT_REPOSITORY "https://github.com/greg7mdp/parallel-hashmap.git"
    GIT_TAG be6a2c7
    TIMEOUT 10
    PREFIX "external_phmap"
    INSTALL_DIR "external_phmap/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DWASI_SDK_PREFIX=${WASI_SDK_PREFIX}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_phmap/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_SYSROOT=${CMAKE_SYSROOT}
        -DCMAKE_BUILD_TYPE=Release
        -DPHMAP_BUILD_TESTS=OFF
        -DPHMAP_BUILD_EXAMPLES=OFF
)

ExternalProject_Get_Property(phmap_ep install_dir)
set(PHMAP_INCLUDE_DIR ${install_dir}/include)
add_library(phmap INTERFACE)
target_include_directories(phmap INTERFACE ${PHMAP_INCLUDE_DIR})
add_dependencies(phmap phmap_ep)
file(MAKE_DIRECTORY ${PHMAP_INCLUDE_DIR})
