package example;

import java.nio.charset.StandardCharsets;

public final class Checksum {
    private Checksum() { }

    public static int checksum(String value) {
        int result = 0;
        for (byte octet : value.getBytes(StandardCharsets.UTF_8)) {
            result = (result + Byte.toUnsignedInt(octet)) % 256;
        }
        return result;
    }
}
