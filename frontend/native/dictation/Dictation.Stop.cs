using System;

partial class Dictation
{
    // Shared by the Windows helper and no-audio lifecycle tests. Platform calls
    // stay behind delegates so this is the production Stop path on every host.
    internal static Action CreateStopHandler(object gate, Func<bool> isFinished,
        Func<byte[]> stopCapture, Action acknowledge, Action<byte[]> transcribe, Action<string> fail)
    {
        bool stopping = false;
        return () => {
            lock (gate)
            {
                if (isFinished() || stopping) return;
                stopping = true;
                byte[] captured;
                try { captured = stopCapture(); }
                catch { fail("microphone"); return; }
                // Capture must be stopped and released before acknowledging it.
                // Transcription receives only the sealed PCM snapshot.
                try { acknowledge(); transcribe(captured); }
                catch { fail("failed"); }
            }
        };
    }
}
