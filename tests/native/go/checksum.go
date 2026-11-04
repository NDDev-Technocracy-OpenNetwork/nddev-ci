// Package fixture is the smallest program that still exercises a real Go
// toolchain: it builds, it has a test, a benchmark and a fuzz target, so one
// tree can prove go-ci, benchmark and fuzzing without pulling a dependency.
package fixture

// Checksum sums the bytes of s modulo 256. Trivial on purpose: the point of
// this fixture is to make the workflow run, not to test arithmetic.
func Checksum(s string) int {
	total := 0
	for _, b := range []byte(s) {
		total += int(b)
	}
	return total % 256
}
