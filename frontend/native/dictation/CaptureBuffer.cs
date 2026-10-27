using System;
using System.IO;

// PCM stays in memory and is sealed before recognition starts.
sealed class CaptureBuffer
{
    public const int SampleRate = 16000;
    public const int MaxBytes = SampleRate * 2 * 60;
    readonly MemoryStream audio = new MemoryStream();
    readonly object gate = new object();
    bool frozen;

    public void Append(byte[] bytes)
    {
        lock (gate)
        {
            if (frozen) return;
            audio.Write(bytes, 0, Math.Min(bytes.Length, MaxBytes - (int)audio.Length));
        }
    }

    public byte[] Freeze()
    {
        lock (gate)
        {
            frozen = true;
            return audio.ToArray();
        }
    }
}
