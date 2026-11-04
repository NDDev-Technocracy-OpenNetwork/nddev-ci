<?php

declare(strict_types=1);
namespace NativeFixture;

final class Checksum
{
    public static function checksum(string $value): int
    {
        return array_sum(array_values(unpack('C*', $value) ?: [])) % 256;
    }
}
