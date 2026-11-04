# Smallest project that configures, builds and registers a ctest test, so one
# tree proves cpp-ci's configure, build and test lanes.
cmake_minimum_required(VERSION 3.16)
project(ciwf_fixture CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(checksum src/main.cpp)

enable_testing()
add_test(NAME checksum_is_stable COMMAND checksum)

set(CPACK_GENERATOR "TGZ")
install(TARGETS checksum RUNTIME DESTINATION bin)
include(CPack)
