include(ExternalProject)

ExternalProject_Add(
    gflags_ep
    GIT_REPOSITORY "https://github.com/gflags/gflags.git"
    GIT_TAG e171aa2
    TIMEOUT 10
    PREFIX "external_gflags"
    INSTALL_DIR "external_gflags/install"
    CMAKE_ARGS
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_gflags/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_FLAGS=-std=c++20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER=${CMAKE_C_COMPILER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_BUILD_TYPE=Release
    BUILD_BYPRODUCTS <INSTALL_DIR>/lib/libgflags.a
)

ExternalProject_Get_Property(gflags_ep install_dir)
set(GFLAGS_INCLUDE_DIR ${install_dir}/include)
set(GFLAGS_LIBRARY_PATH ${install_dir}/lib/libgflags.a)
add_library(gflags STATIC IMPORTED)
set_property(TARGET gflags PROPERTY IMPORTED_LOCATION ${GFLAGS_LIBRARY_PATH})
set_property(TARGET gflags APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${GFLAGS_INCLUDE_DIR})
add_dependencies(gflags gflags_ep)

file(MAKE_DIRECTORY ${GFLAGS_INCLUDE_DIR})
