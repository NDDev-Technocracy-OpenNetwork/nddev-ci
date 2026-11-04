package fixture

import "testing"

func TestChecksumIsStable(t *testing.T) {
	if got := Checksum("ci"); got != 204 {
		t.Fatalf("Checksum(\"ci\") = %d, want 204", got)
	}
	if got := Checksum(""); got != 0 {
		t.Fatalf("Checksum(\"\") = %d, want 0", got)
	}
}

func BenchmarkChecksum(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Checksum("the quick brown fox")
	}
}

// FuzzChecksum gives fuzzing.yml a real target. The invariant is deliberately
// one the implementation cannot violate, so a fuzz run proves the workflow
// starts and reports, and does not become a flaky test of arithmetic.
func FuzzChecksum(f *testing.F) {
	f.Add("ci")
	f.Add("")
	f.Fuzz(func(t *testing.T, s string) {
		if got := Checksum(s); got < 0 || got > 255 {
			t.Fatalf("Checksum(%q) = %d, outside [0,255]", s, got)
		}
	})
}
