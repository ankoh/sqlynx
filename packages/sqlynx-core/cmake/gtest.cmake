include(ExternalProject)

ExternalProject_Add(
    gtest_ep
    GIT_REPOSITORY "https://github.com/google/googletest.git"
    GIT_TAG b796f7d
    TIMEOUT 10
    PREFIX "external_gtest"
    INSTALL_DIR "external_gtest/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DINSTALL_GTEST=ON
        -DBUILD_GMOCK=ON
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_gtest/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_FLAGS=-std=c++20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER=${CMAKE_C_COMPILER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_BUILD_TYPE=Release
    BUILD_BYPRODUCTS
        <INSTALL_DIR>/lib/libgtest.a
        <INSTALL_DIR>/lib/libgmock.a
)

ExternalProject_Get_Property(gtest_ep install_dir)

set(GTEST_INCLUDE_DIR ${install_dir}/include)
set(GTEST_LIBRARY_PATH ${install_dir}/lib/libgtest.a)
add_library(gtest STATIC IMPORTED)
set_property(TARGET gtest PROPERTY IMPORTED_LOCATION ${GTEST_LIBRARY_PATH})
set_property(TARGET gtest APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${GTEST_INCLUDE_DIR})

set(GMOCK_INCLUDE_DIR ${install_dir}/include)
set(GMOCK_LIBRARY_PATH ${install_dir}/lib/libgmock.a)
add_library(gmock STATIC IMPORTED)
set_property(TARGET gmock PROPERTY IMPORTED_LOCATION ${GMOCK_LIBRARY_PATH})
set_property(TARGET gmock APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${GTEST_INCLUDE_DIR})

add_dependencies(gtest gtest_ep)
add_dependencies(gmock gtest_ep)

file(MAKE_DIRECTORY ${GTEST_INCLUDE_DIR})

