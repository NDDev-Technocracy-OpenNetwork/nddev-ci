#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  uint8_t checksum = 0;
  for (size_t i = 0; i < size; ++i) {
    checksum ^= data[i];
  }
  static volatile uint8_t observed_checksum;
  observed_checksum = checksum;
  // The negative workflow cell enables this actual source defect before compilation.
  constexpr bool injected_defect = false;
  constexpr char trigger[] = "NDDev controlled ClusterFuzzLite negative acceptance seed";
  if (injected_defect && size == sizeof(trigger) - 1 && std::memcmp(data, trigger, size) == 0) {
    std::abort();
  }
  return 0;
}
