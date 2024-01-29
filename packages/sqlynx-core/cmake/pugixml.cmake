include(ExternalProject)

ExternalProject_Add(
    pugixml_ep
    GIT_REPOSITORY "https://github.com/zeux/pugixml.git"
    GIT_TAG a0e0643 
    TIMEOUT 10
    PREFIX "external_pugixml"
    INSTALL_DIR "external_pugixml/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_pugixml/install
        -DCMAKE_CXX_STANDARD=17
        -DCMAKE_CXX_FLAGS=-std=c++17
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_MODULE_PATH=${CMAKE_MODULE_PATH}
        -DCMAKE_BUILD_TYPE=Release
    BUILD_BYPRODUCTS <INSTALL_DIR>/lib/libpugixml.a
)

ExternalProject_Get_Property(pugixml_ep install_dir)
set(PUGIXML_INCLUDE_DIR ${install_dir}/include)
set(PUGIXML_LIBRARY_PATH ${install_dir}/lib/libpugixml.a)
add_library(pugixml STATIC IMPORTED)
set_property(TARGET pugixml PROPERTY IMPORTED_LOCATION ${PUGIXML_LIBRARY_PATH})
set_property(TARGET pugixml APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${PUGIXML_INCLUDE_DIR})
add_dependencies(pugixml pugixml_ep)

file(MAKE_DIRECTORY ${PUGIXML_INCLUDE_DIR})
