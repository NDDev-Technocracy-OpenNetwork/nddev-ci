#include <cstddef>
#include <cstdint>

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data,
                                      std::size_t size) {
  std::uint8_t checksum = 0;
  for (std::size_t index = 0; index < size; ++index) {
    checksum = static_cast<std::uint8_t>(checksum + data[index]);
  }
  volatile std::uint8_t observed = checksum;
  (void)observed;
  return 0;
}
