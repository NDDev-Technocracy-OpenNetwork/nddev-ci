package example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class ChecksumTest {
    @Test
    void knownPayload() {
        assertEquals(204, Checksum.checksum("ci"));
        assertEquals(0, Checksum.checksum(""));
    }

    @Test
    void modularBound() {
        for (String value : new String[] {"", "a", "the quick brown fox"}) {
            assertTrue(Checksum.checksum(value) >= 0 && Checksum.checksum(value) <= 255);
        }
    }
}
