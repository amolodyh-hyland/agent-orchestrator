using System;
using System.Runtime.InteropServices;

// Native boundary only; capture ownership and Stop remain in WaveInCapture.
class WaveInApi
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint SampleRate, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WaveHeader
    {
        public IntPtr Data;
        public uint BufferLength, BytesRecorded;
        public UIntPtr User;
        public uint Flags, Loops;
        public IntPtr Next;
        public UIntPtr Reserved;
    }

    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr input, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr input);
    [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr input);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr input);

    public virtual uint Open(out IntPtr input, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags) { return waveInOpen(out input, device, ref format, callback, instance, flags); }
    public virtual uint PrepareHeader(IntPtr input, IntPtr header, uint size) { return waveInPrepareHeader(input, header, size); }
    public virtual uint AddBuffer(IntPtr input, IntPtr header, uint size) { return waveInAddBuffer(input, header, size); }
    public virtual uint Start(IntPtr input) { return waveInStart(input); }
    public virtual uint Reset(IntPtr input) { return waveInReset(input); }
    public virtual uint UnprepareHeader(IntPtr input, IntPtr header, uint size) { return waveInUnprepareHeader(input, header, size); }
    public virtual uint Close(IntPtr input) { return waveInClose(input); }
}
