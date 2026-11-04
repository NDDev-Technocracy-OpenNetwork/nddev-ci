// Smallest program that still asserts something, so ctest can pass or fail on
// behaviour rather than on the binary merely existing.
#include <cstdlib>
#include <iostream>
#include <string>

namespace {

int Checksum(const std::string &text) {
  int total = 0;
  for (unsigned char byte : text) {
    total += byte;
  }
  return total % 256;
}

} // namespace

int main() {
  if (Checksum("ci") != 204 || Checksum("") != 0) {
    std::cerr << "checksum fixture failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "checksum fixture ok\n";
  return EXIT_SUCCESS;
}
