using CiwfFixture;

namespace Checksum.Tests;

public class ChecksumTests
{
    [Fact]
    public void StableChecksumsIncludeUtf8()
    {
        Assert.Equal((byte)204, ByteChecksum.Compute("ci"));
        Assert.Equal((byte)127, ByteChecksum.Compute("ü"));
        Assert.Equal((byte)0, ByteChecksum.Compute(""));
    }

    [Fact]
    public void ResultFitsOneByte()
    {
        foreach (var text in new[] { "a", "the quick brown fox", new string('ü', 1000) })
        {
            Assert.InRange((int)ByteChecksum.Compute(text), 0, 255);
        }
    }
}
