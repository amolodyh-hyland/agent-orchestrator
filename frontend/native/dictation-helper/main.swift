import AVFoundation
import Foundation
import Speech

// Streams one dictation as JSON lines on stdout. "stop" on stdin (or EOF)
// ends the audio and waits for the final transcript; "cancel" exits at once.

let output = DispatchQueue(label: "ao.dictation.output")

// Serialized on the output queue: the meter's levels come from the real-time
// audio thread, which must not do this work.
func emit(_ event: [String: Any]) {
	output.async {
		guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data([0x0A]))
	}
}

func finish(_ event: [String: Any], code: Int32) -> Never {
	emit(event)
	output.sync {}
	exit(code)
}

func fail(_ message: String, error: String = "failed") -> Never {
	finish(["type": "error", "error": error, "message": message], code: 1)
}

// Loudness of one render cycle of the first channel, mapped from -60...-10 dBFS onto 0...1.
func level(_ samples: UnsafePointer<Float>, count: Int) -> Double {
	var sum: Float = 0
	for index in 0..<count { sum += samples[index] * samples[index] }
	let decibels = 20 * log10(max(sqrt(sum / Float(count)), 1e-6))
	return (Double(min(max((decibels + 60) / 50, 0), 1)) * 1000).rounded() / 1000
}

final class Dictation {
	private let recognizer: SFSpeechRecognizer
	private let engine = AVAudioEngine()
	private let request = SFSpeechAudioBufferRecognitionRequest()
	private var task: SFSpeechRecognitionTask?
	private var text = ""
	/** What was heard, one utterance per pause. `end` is the audio time an ended utterance ran to. */
	private var utterances: [(text: String, end: TimeInterval?)] = []
	private var stopping = false
	private var tapped = false

	init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

	func start() {
		guard !stopping else { return }
		guard recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
			fail("Speech recognition is not available for your language.", error: "unavailable")
		}
		request.shouldReportPartialResults = true
		request.taskHint = .dictation
		if #available(macOS 13, *) { request.addsPunctuation = true }
		request.requiresOnDeviceRecognition = true

		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else { fail("No microphone found.", error: "microphone") }
		let request = self.request
		input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
			request.append(buffer)
		}
		tapped = true
		// The tap hands over about 100 ms at a time, too late for the meter. A sink
		// node runs every render cycle, so levels leave within a few milliseconds.
		let sink = AVAudioSinkNode { _, frameCount, audio in
			let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: audio))
			guard frameCount > 0, let samples = buffers.first?.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
			emit(["type": "levels", "values": [level(samples, count: Int(frameCount))]])
			return noErr
		}
		engine.attach(sink)
		engine.connect(input, to: sink, format: format)

		task = recognizer.recognitionTask(with: request) { [weak self] result, error in
			DispatchQueue.main.async {
				guard let self else { return }
				if let result {
					self.hear(result)
					if result.isFinal { finish(["type": "end", "text": self.text], code: 0) }
					emit(["type": "text", "text": self.text])
				} else if error != nil {
					// Stopping with no speech also ends here; keep whatever was heard.
					if self.stopping { finish(["type": "end", "text": self.text], code: 0) }
					fail("Dictation stopped.")
				}
			}
		}

		engine.prepare()
		do { try engine.start() } catch { fail("Could not start the microphone.", error: "microphone") }
		emit(["type": "listening"])
		DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in self?.stop() }
	}

	// The recognizer reports one utterance at a time: partial results while it
	// hears words (their timestamps are all zero), then, at a pause, the ended
	// utterance with real audio timestamps. The next partial starts a new
	// utterance. An ended utterance can come back revised (the final result on
	// stop often does); its words start inside that utterance's audio, so it
	// replaces the utterance instead of adding a copy.
	private func hear(_ result: SFSpeechRecognitionResult) {
		let heard = result.bestTranscription.formattedString
		let segments = result.bestTranscription.segments
		let ended = result.speechRecognitionMetadata != nil || result.isFinal
		let end = segments.last.map { $0.timestamp + $0.duration }
		let index: Int?
		if ended, let start = segments.first?.timestamp {
			// The ended utterance whose audio this result starts in, else the open one.
			index = utterances.lastIndex { $0.end.map { start < $0 - 0.05 } ?? true }
		} else {
			index = utterances.isEmpty || utterances[utterances.count - 1].end != nil ? nil : utterances.count - 1
		}
		if heard.isEmpty {
			if let index, utterances[index].end == nil { utterances.remove(at: index) }
		} else if let index {
			utterances[index] = (heard, ended ? end : nil)
			// Anything heard after a revised utterance was part of it.
			utterances.removeSubrange((index + 1)...)
		} else {
			utterances.append((heard, ended ? end : nil))
		}
		text = utterances.map(\.text).joined(separator: " ")
	}

	func stop() {
		guard !stopping else { return }
		stopping = true
		// Stopped before access was granted and listening began: nothing to finish.
		guard task != nil else { finish(["type": "end", "text": ""], code: 0) }
		engine.stop()
		if tapped {
			engine.inputNode.removeTap(onBus: 0)
			tapped = false
		}
		emit(["type": "finishing"])
		request.endAudio()
		DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
			finish(["type": "end", "text": self?.text ?? ""], code: 0)
		}
	}
}

// macOS asks the responsible process (the app or terminal that launched AO)
// for speech and microphone access, and kills the helper when that process
// has no usage strings. Relaunch once so the helper is responsible for itself
// and macOS reads the helper app bundle's usage strings and icon.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

var disclaimedChild: pid_t = 0

if getenv("AO_DICTATION_DISCLAIMED") == nil, let executable = Bundle.main.executablePath {
	setenv("AO_DICTATION_DISCLAIMED", "1", 1)
	var attrs: posix_spawnattr_t?
	guard posix_spawnattr_init(&attrs) == 0 else { fail("Dictation is not available.", error: "unavailable") }
	guard responsibility_spawnattrs_setdisclaim(&attrs, 1) == 0 else { fail("Dictation is not available.", error: "unavailable") }
	let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
	let spawned = posix_spawn(&disclaimedChild, executable, nil, &attrs, argv, environ)
	posix_spawnattr_destroy(&attrs)
	for argument in argv { free(argument) }
	if spawned == 0 {
		signal(SIGTERM) { _ in
			kill(disclaimedChild, SIGTERM)
			exit(0)
		}
		var status: Int32 = 0
		waitpid(disclaimedChild, &status, 0)
		exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
	}
	fail("Dictation is not available.", error: "unavailable")
}

let args = CommandLine.arguments
guard args.count == 3, ["--probe", "--record"].contains(args[1]),
	let identifier = dictationLocaleIdentifier(requested: args[2], supported: SFSpeechRecognizer.supportedLocales().map(\.identifier), preferred: Locale.current.identifier),
	let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)),
	recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
	fail("Speech recognition is not available for your language.", error: "unavailable")
}
let speechPermission = SFSpeechRecognizer.authorizationStatus()
let microphonePermission = AVCaptureDevice.authorizationStatus(for: .audio)
if speechPermission == .denied || speechPermission == .restricted || microphonePermission == .denied || microphonePermission == .restricted {
	fail("Allow Speech Recognition and Microphone access for Orchestrator in System Settings > Privacy & Security.", error: "permission")
}
if args[1] == "--probe" {
	finish(["type": "listening"], code: 0)
}

let dictation = Dictation(recognizer)

Thread.detachNewThread {
	while let line = readLine() {
		if line == "cancel" { exit(0) }
		if line == "stop" { break }
	}
	DispatchQueue.main.async { dictation.stop() }
}

SFSpeechRecognizer.requestAuthorization { status in
	guard status == .authorized else {
		fail("Allow Speech Recognition for Orchestrator in System Settings > Privacy & Security.", error: "permission")
	}
	AVCaptureDevice.requestAccess(for: .audio) { granted in
		guard granted else {
			fail("Allow Microphone access for Orchestrator in System Settings > Privacy & Security.", error: "permission")
		}
		DispatchQueue.main.async { dictation.start() }
	}
}

dispatchMain()
