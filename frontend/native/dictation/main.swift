import Foundation
import AVFoundation
import Speech

func output(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else { exit(1) }
    print(line)
    fflush(stdout)
}

final class Dictation {
    private let recognizer: SFSpeechRecognizer
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapped = false
    private var finished = false
    private var stopping = false
    private var latest = ""

    init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

    func fail(_ code: String) {
        finish(["type": "error", "error": code])
    }

    func finish(_ event: [String: Any]) {
        guard !finished else { return }
        finished = true
        closeMicrophone()
        task?.cancel()
        output(event)
        exit(0)
    }

    private func closeMicrophone() {
        audio.stop()
        if tapped {
            audio.inputNode.removeTap(onBus: 0)
            tapped = false
        }
    }

    func authorize() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.fail("permission"); return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard granted else { self.fail("permission"); return }
                        self.start()
                    }
                }
            }
        }
    }

    private func start() {
        guard recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { fail("unavailable"); return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        self.request = request
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                if let result = result {
                    self.latest = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.finish(["type": "result", "text": self.latest])
                        return
                    }
                }
                if error != nil {
                    if self.stopping && !self.latest.isEmpty {
                        self.finish(["type": "result", "text": self.latest])
                    } else { self.fail("failed") }
                }
            }
        }
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { fail("microphone"); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapped = true
        do {
            audio.prepare()
            try audio.start()
        } catch { fail("microphone"); return }
        output(["type": "recording"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.stop() }
    }

    func stop() {
        guard !finished, !stopping else { return }
        stopping = true
        closeMicrophone()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            guard !self.finished else { return }
            self.finish(["type": "result", "text": self.latest])
        }
    }

    func cancel() { finish(["type": "cancelled"]) }
}

let args = CommandLine.arguments
if args.count != 3 || !["--probe", "--record"].contains(args[1]) { exit(1) }
guard let identifier = dictationLocaleIdentifier(requested: args[2], supported: SFSpeechRecognizer.supportedLocales().map { $0.identifier }, preferred: Locale.current.identifier),
      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)),
      recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
    output(["type": "error", "error": "unavailable"])
    exit(0)
}
let speechPermission = SFSpeechRecognizer.authorizationStatus()
let microphonePermission = AVCaptureDevice.authorizationStatus(for: .audio)
if speechPermission == .denied || speechPermission == .restricted || microphonePermission == .denied || microphonePermission == .restricted {
    output(["type": "error", "error": "permission"])
    exit(0)
}
if args[1] == "--probe" {
    output(["type": "recording"])
    exit(0)
}
let dictation = Dictation(recognizer)
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        DispatchQueue.main.async {
            if line == "stop" { dictation.stop() }
            else { dictation.cancel() }
        }
    }
    DispatchQueue.main.async { dictation.cancel() }
}
dictation.authorize()
RunLoop.main.run()
