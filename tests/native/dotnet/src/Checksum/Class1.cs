using System.Text;

namespace CiwfFixture;

public static class ByteChecksum
{
    public static byte Compute(string text)
    {
        var sum = 0;
        foreach (var value in Encoding.UTF8.GetBytes(text))
        {
            sum = (sum + value) % 256;
        }
        return (byte)sum;
    }
}
