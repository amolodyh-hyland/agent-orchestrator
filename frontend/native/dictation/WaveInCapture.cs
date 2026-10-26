using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// Use WinMM capture independently of System.Speech. RecognizeAsyncStop leaves
// SAPI's default microphone input live until the current phrase completes.
sealed class WaveInCapture : IDisposable
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint SampleRate, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveHeader
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

    readonly object gate = new object();
    readonly AutoResetEvent ready = new AutoResetEvent(false);
    readonly List<IntPtr> headers = new List<IntPtr>();
    readonly Queue<IntPtr> pending = new Queue<IntPtr>();
    readonly CaptureBuffer audio = new CaptureBuffer();
    static readonly uint HeaderSize = (uint)Marshal.SizeOf(typeof(WaveHeader));
    IntPtr input;
    Thread reader;
    bool running;
    bool disposed;

    static void Check(uint result)
    {
        if (result != 0) throw new InvalidOperationException("Microphone capture failed");
    }

    public void Start(Action failed)
    {
        lock (gate)
        {
            var format = new WaveFormat {
                Tag = 1, Channels = 1, SampleRate = CaptureBuffer.SampleRate,
                BytesPerSecond = CaptureBuffer.SampleRate * 2, BlockAlign = 2, BitsPerSample = 16
            };
            // CALLBACK_EVENT: the OS signals an event; no managed callback can
            // race buffer disposal or block waveInReset while holding our lock.
            Check(waveInOpen(out input, uint.MaxValue, ref format, ready.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, 0x50000));
            for (int i = 0; i < 4; i++)
            {
                var header = new WaveHeader { Data = Marshal.AllocHGlobal(3200), BufferLength = 3200 };
                var address = Marshal.AllocHGlobal((int)HeaderSize);
                Marshal.StructureToPtr(header, address, false);
                headers.Add(address);
                Check(waveInPrepareHeader(input, address, HeaderSize));
                Check(waveInAddBuffer(input, address, HeaderSize));
                pending.Enqueue(address);
            }
            Check(waveInStart(input));
            running = true;
            reader = new Thread(() => {
                try
                {
                    while (true)
                    {
                        ready.WaitOne();
                        lock (gate)
                        {
                            if (!running) return;
                            Drain(true);
                        }
                    }
                }
                catch { failed(); }
            });
            reader.IsBackground = true;
            reader.Start();
        }
    }

    void Drain(bool requeue)
    {
        while (pending.Count > 0)
        {
            var address = pending.Peek();
            var header = (WaveHeader)Marshal.PtrToStructure(address, typeof(WaveHeader));
            if ((header.Flags & 1) == 0) break; // WHDR_DONE
            pending.Dequeue();
            var bytes = new byte[header.BytesRecorded];
            Marshal.Copy(header.Data, bytes, 0, bytes.Length);
            audio.Append(bytes);
            if (requeue)
            {
                Check(waveInAddBuffer(input, address, HeaderSize));
                pending.Enqueue(address);
            }
        }
    }

    public byte[] Stop()
    {
        lock (gate)
        {
            running = false;
            if (input != IntPtr.Zero)
            {
                // Reset stops the device immediately and returns queued buffers,
                // including the last partially filled buffer. Nothing is requeued.
                Check(waveInReset(input));
                Drain(false);
                foreach (var address in headers) Check(waveInUnprepareHeader(input, address, HeaderSize));
                Check(waveInClose(input));
                input = IntPtr.Zero;
                foreach (var address in headers)
                {
                    var header = (WaveHeader)Marshal.PtrToStructure(address, typeof(WaveHeader));
                    Marshal.FreeHGlobal(header.Data);
                    Marshal.FreeHGlobal(address);
                }
                headers.Clear();
            }
            ready.Set();
            return audio.Freeze();
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        Stop();
        if (reader != null && reader != Thread.CurrentThread) reader.Join();
        ready.Dispose();
        disposed = true;
    }
}
