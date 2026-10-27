using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class StopTests
{
    // Simulate the WinMM device at its native call boundary. The real capture
    // owns the headers, reader, buffer drain, Stop, close, and memory release.
    sealed class FakeWaveIn : WaveInApi
    {
        readonly List<IntPtr> headers = new List<IntPtr>();
        readonly HashSet<IntPtr> prepared = new HashSet<IntPtr>();
        public readonly List<string> Events = new List<string>();
        public bool Recording, Released;
        public int LateBuffers, ResetCalls, CloseCalls;
        public string FailOnce;

        public override uint Open(out IntPtr input, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags)
        {
            input = new IntPtr(1);
            return 0;
        }
        public override uint PrepareHeader(IntPtr input, IntPtr address, uint size)
        {
            prepared.Add(address);
            return 0;
        }
        public override uint AddBuffer(IntPtr input, IntPtr address, uint size)
        {
            var header = Read(address);
            header.Flags = 2 | 16; // WHDR_PREPARED | WHDR_INQUEUE
            header.BytesRecorded = 0;
            Marshal.StructureToPtr(header, address, false);
            headers.Add(address);
            return 0;
        }
        public override uint Start(IntPtr input) { Recording = true; return 0; }
        public override uint Reset(IntPtr input)
        {
            ResetCalls++;
            if (FailOnce == "reset") { FailOnce = null; return 1; }
            Recording = false;
            Events.Add("stop");
            foreach (var address in headers)
            {
                var header = Read(address);
                header.Flags = 1 | 2; // Return full and partially filled buffers.
                Marshal.StructureToPtr(header, address, false);
            }
            return 0;
        }
        public override uint UnprepareHeader(IntPtr input, IntPtr address, uint size)
        {
            if (Recording) throw new Exception("Unprepared a live capture buffer");
            prepared.Remove(address);
            return 0;
        }
        public override uint Close(IntPtr input)
        {
            CloseCalls++;
            if (Recording || prepared.Count != 0) throw new Exception("Closed before reset/unprepare");
            if (FailOnce == "close") { FailOnce = null; return 1; }
            Released = true;
            headers.Clear();
            Events.Add("release");
            return 0;
        }
        static WaveHeader Read(IntPtr address) { return (WaveHeader)Marshal.PtrToStructure(address, typeof(WaveHeader)); }

        public void Deliver(int index, params byte[] bytes)
        {
            // The source keeps attempting delivery after Stop. A reset/released
            // input cannot write another native buffer or reopen recognition.
            if (!Recording || Released) { LateBuffers++; return; }
            var address = headers[index];
            var header = Read(address);
            Marshal.Copy(bytes, 0, header.Data, bytes.Length);
            header.BytesRecorded = (uint)bytes.Length;
            Marshal.StructureToPtr(header, address, false);
        }
    }

    static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    public static void Run()
    {
        var source = new FakeWaveIn();
        using (var capture = new WaveInCapture(source))
        {
            capture.Start(() => { throw new Exception("Capture reader failed"); });
            // Both buffers are still queued; Stop must recover the final partial
            // buffer in capture order, rather than discard an unfinished phrase.
            source.Deliver(0, 1, 2);
            source.Deliver(1, 3, 4);
            byte[] recognized = null;
            var stop = Dictation.CreateStopHandler(new object(), () => false, capture.Stop,
                () => {
                    Assert(!source.Recording && source.Released, "Shutdown ack preceded capture release");
                    source.Deliver(0, 99, 100);
                    source.Events.Add("ack");
                },
                pcm => {
                    Assert(source.Events[source.Events.Count - 1] == "ack", "Transcription preceded shutdown ack");
                    source.Deliver(0, 101, 102);
                    recognized = pcm;
                    source.Events.Add("transcribe");
                },
                error => { throw new Exception("Unexpected Stop error: " + error); });
            stop();
            source.Deliver(0, 103, 104);
            stop();
            Assert(string.Join(",", source.Events) == "stop,release,ack,transcribe", "Incorrect production Stop ordering");
            Assert(BitConverter.ToString(recognized) == "01-02-03-04", "Post-stop PCM reached transcription or partial audio was lost");
            Assert(source.LateBuffers == 3, "Fake source did not attempt post-stop delivery");
            Assert(source.ResetCalls == 1 && source.CloseCalls == 1, "Repeated Stop repeated device shutdown");
        }

        foreach (var failure in new[] { "reset", "close" })
        {
            source = new FakeWaveIn { FailOnce = failure };
            using (var capture = new WaveInCapture(source))
            {
                capture.Start(() => { throw new Exception("Capture reader failed"); });
                var events = new List<string>();
                var stop = Dictation.CreateStopHandler(new object(), () => false, capture.Stop,
                    () => events.Add("ack"), pcm => events.Add("transcribe"), error => events.Add(error));
                stop();
                Assert(string.Join(",", events) == "microphone", "Acknowledged/transcribed after failed " + failure);
            }
            Assert(source.Released, "Dispose did not release capture after failed " + failure);
        }
        Console.WriteLine("3 production Stop lifecycle scenarios passed without audio");
    }
}
