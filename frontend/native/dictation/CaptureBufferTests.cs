using System;

class CaptureBufferTests
{
    static void Main()
    {
        var buffer = new CaptureBuffer();
        buffer.Append(new byte[] { 1, 2 });
        buffer.Append(new byte[] { 3, 4 });
        var captured = buffer.Freeze();
        // A fake microphone keeps delivering data after Stop: recognition must
        // still see only the bytes captured before the buffer was sealed.
        buffer.Append(new byte[] { 99, 100 });
        if (BitConverter.ToString(captured) != "01-02-03-04" || BitConverter.ToString(buffer.Freeze()) != "01-02-03-04")
            throw new Exception("Post-stop audio entered the transcript input");
        captured[0] = 255;
        if (buffer.Freeze()[0] != 1) throw new Exception("Recognition mutated capture memory");
        var bounded = new CaptureBuffer();
        bounded.Append(new byte[CaptureBuffer.MaxBytes + 100]);
        if (bounded.Freeze().Length != CaptureBuffer.MaxBytes) throw new Exception("Capture exceeded 60 seconds");
        Console.WriteLine("3 capture boundary checks passed without audio");
    }
}
