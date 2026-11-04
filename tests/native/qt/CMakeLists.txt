cmake_minimum_required(VERSION 3.21)
project(ci_workflows_qt_fixture VERSION 1.0 LANGUAGES CXX)

set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.12.0 EXACT REQUIRED COMPONENTS Core Test)

add_library(fixture_identity STATIC src/fixture_identity.cpp)
target_include_directories(fixture_identity PUBLIC src)
target_link_libraries(fixture_identity PUBLIC Qt6::Core)

qt_add_executable(fixture_identity_tests tests/fixture_identity_test.cpp)
target_link_libraries(fixture_identity_tests PRIVATE fixture_identity Qt6::Test)

enable_testing()
add_test(NAME fixture_identity COMMAND fixture_identity_tests)

set(CPACK_GENERATOR "TGZ")
install(TARGETS fixture_identity fixture_identity_tests RUNTIME DESTINATION bin ARCHIVE DESTINATION lib)
include(CPack)
