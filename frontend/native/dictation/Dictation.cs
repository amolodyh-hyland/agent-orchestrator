using System;
using System.Globalization;
using System.Linq;
using System.Speech.Recognition;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

class Dictation
{
    static readonly object Gate = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly ManualResetEvent Done = new ManualResetEvent(false);
    static readonly StringBuilder Text = new StringBuilder();
    static bool finished;
    static bool stopping;

    static void Emit(object value)
    {
        Console.WriteLine(Json.Serialize(value));
        Console.Out.Flush();
    }

    static void Finish(object value)
    {
        lock (Gate)
        {
            if (finished) return;
            finished = true;
            try { Emit(value); }
            catch (System.IO.IOException) { }
            finally { Done.Set(); }
        }
    }

    static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length != 2 || (args[0] != "--probe" && args[0] != "--record")) return;
        try
        {
            var culture = CultureInfo.GetCultureInfo(args[1]);
            var info = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r =>
                (r.Culture.Equals(culture) || (culture.IsNeutralCulture && r.Culture.TwoLetterISOLanguageName == culture.TwoLetterISOLanguageName)) &&
                Regex.IsMatch(r.Id, @"^(?:.*\\)?MS-[0-9A-Fa-f]+-\d+-DESK$", RegexOptions.IgnoreCase));
            if (info == null)
            {
                Emit(new { type = "error", error = "unavailable" });
                return;
            }
            using (var engine = new SpeechRecognitionEngine(info))
            {
                engine.LoadGrammar(new DictationGrammar());
                if (args[0] == "--probe")
                {
                    Emit(new { type = "recording" });
                    return;
                }
                engine.SpeechRecognized += (sender, e) =>
                {
                    lock (Gate)
                    {
                        if (finished || e.Result == null) return;
                        if (Text.Length > 0) Text.Append(" ");
                        Text.Append(e.Result.Text);
                        if (Text.Length > 32768) Finish(new { type = "error", error = "failed" });
                    }
                };
                engine.RecognizeCompleted += (sender, e) =>
                {
                    lock (Gate)
                    {
                        if (e.Error != null) Finish(new { type = "error", error = "failed" });
                        else Finish(new { type = "result", text = Text.ToString() });
                    }
                };
                engine.SetInputToDefaultAudioDevice();
                engine.RecognizeAsync(RecognizeMode.Multiple);
                Emit(new { type = "recording" });
                Action stop = () =>
                {
                    lock (Gate)
                    {
                        if (finished || stopping) return;
                        stopping = true;
                        engine.RecognizeAsyncStop();
                    }
                };
                var input = new Thread(() =>
                {
                    try
                    {
                        string command;
                        while ((command = Console.ReadLine()) != null)
                        {
                            if (command == "stop") stop();
                            else { Finish(new { type = "cancelled" }); return; }
                        }
                        Finish(new { type = "cancelled" });
                    }
                    catch { Finish(new { type = "error", error = "failed" }); }
                });
                input.IsBackground = true;
                input.Start();
                using (var limit = new Timer(_ => stop(), null, 60000, Timeout.Infinite))
                {
                    Done.WaitOne();
                }
                engine.RecognizeAsyncCancel();
                engine.SetInputToNull();
            }
        }
        catch (UnauthorizedAccessException) { Finish(new { type = "error", error = "permission" }); }
        catch (System.Runtime.InteropServices.COMException e)
        {
            Finish(new { type = "error", error = e.ErrorCode == unchecked((int)0x80070005) ? "permission" : "microphone" });
        }
        catch { Finish(new { type = "error", error = "unavailable" }); }
    }
}
