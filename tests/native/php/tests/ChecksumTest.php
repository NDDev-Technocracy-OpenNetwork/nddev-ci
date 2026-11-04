<?php

declare(strict_types=1);
use NativeFixture\Checksum;
use PHPUnit\Framework\TestCase;

final class ChecksumTest extends TestCase
{
    public function testKnownPayloads(): void
    {
        self::assertSame(204, Checksum::checksum('ci'));
        self::assertSame(0, Checksum::checksum(''));
    }

    public function testModularRange(): void
    {
        foreach (['', 'a', 'the quick brown fox'] as $value) {
            self::assertGreaterThanOrEqual(0, Checksum::checksum($value));
            self::assertLessThanOrEqual(255, Checksum::checksum($value));
        }
    }
}
