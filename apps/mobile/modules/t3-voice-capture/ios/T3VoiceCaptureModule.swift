import AVFoundation
import ExpoModulesCore
import NaturalLanguage
import Speech
import UIKit

/// iOS hands a recording that starts in the background only silence, so hands-free mode starts one
/// microphone input in the foreground, keeps it running, and saves only the spans it asks for.
/// The audio session itself is configured from JavaScript (playAndRecord, background).
final class T3VoiceCapture {
  /// Running, interrupted and error changes, for JavaScript.
  var onState: (([String: Any]) -> Void)?

  private var engine = AVAudioEngine()
  private let lock = NSLock()
  /// What both transcribers take well, whatever the route: 16 kHz mono, saved as 16-bit WAV.
  private let segmentFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  private let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("t3-voice-capture", isDirectory: true)
  private var converter: AVAudioConverter?
  private var file: AVAudioFile?
  private var fileURL: URL?
  private var segmentFrames: AVAudioFramePosition = 0
  private var segmentPeak: Float = 0
  private var level: Float = 0
  /// JavaScript wants the microphone on; it stays on across interruptions and route changes.
  private var running = false
  private var interrupted = false
  /// Restarted while the app was not in front, where iOS may hand the input only silence.
  private var suspect = false
  /// When a call, Siri or a lost route last paused audio; expo-audio pauses every player then.
  private var disruptedAt: Date?
  private var observers: [NSObjectProtocol] = []

  func start() throws {
    if running { return }
    clearDirectory()
    try installTapAndStart()
    running = true
    interrupted = false
    setSuspect(false)
    observe()
    emit(nil)
  }

  /// Called when the app comes to the front: restarts an input that may be dead, now that a
  /// restart records real audio again.
  func recover() {
    guard running else { return }
    if interrupted {
      // Still in a call when this fails; the interruption's end restarts it.
      guard (try? AVAudioSession.sharedInstance().setActive(true)) != nil else { return }
      interrupted = false
    } else if !suspect && engine.isRunning {
      return
    }
    restart()
  }

  private func markDisrupted() {
    lock.lock()
    disruptedAt = Date()
    lock.unlock()
  }

  private func installTapAndStart() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
      let converter = AVAudioConverter(from: format, to: segmentFormat)
    else {
      throw NSError(
        domain: "T3VoiceCapture", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
    }
    converter.downmix = true
    lock.lock()
    self.converter = converter
    lock.unlock()
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.receive(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  private func observe() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      // Synchronous on the posting thread, so the mark lands before expo-audio's player pauses
      // reach JavaScript.
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: session, queue: nil
      ) { [weak self] note in
        // Only a beginning pauses audio; marking the end too would swallow a press right after.
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .began
        else { return }
        self?.markDisrupted()
      },
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: session, queue: nil
      ) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        else { return }
        self?.markDisrupted()
      },
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: session, queue: .main
      ) { [weak self] note in
        guard let self, self.running,
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        if type == .began {
          // A call or Siri took the microphone; the segment keeps what came before.
          self.interrupted = true
          self.emit(nil)
        } else {
          self.interrupted = false
          try? session.setActive(true)
          self.restart()
        }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main
      ) { [weak self] _ in
        // The old engine is gone with the media server; a new one takes the current route.
        guard let self, self.running else { return }
        self.removeEngineObserver()
        self.engine = AVAudioEngine()
        self.observeEngine()
        self.restart()
      },
    ]
    observeEngine()
  }

  private var engineObserver: NSObjectProtocol?

  private func observeEngine() {
    engineObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in
      // A route change (car, AirPods) stops the engine; restart it on the new input.
      guard let self, self.running, !self.interrupted else { return }
      self.restart()
    }
  }

  private func removeEngineObserver() {
    if let engineObserver { NotificationCenter.default.removeObserver(engineObserver) }
    engineObserver = nil
  }

  private func restart() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    let foreground = UIApplication.shared.applicationState == .active
    do {
      try installTapAndStart()
      setSuspect(!foreground)
      emit(nil)
    } catch {
      emit(error.localizedDescription)
    }
  }

  private func setSuspect(_ value: Bool) {
    lock.lock()
    suspect = value
    lock.unlock()
  }

  private func emit(_ error: String?) {
    lock.lock()
    let suspect = self.suspect
    lock.unlock()
    var body: [String: Any] = [
      "running": running && engine.isRunning, "interrupted": interrupted, "suspect": suspect,
    ]
    if let error { body["error"] = error }
    onState?(body)
  }

  private func receive(_ buffer: AVAudioPCMBuffer) {
    var peak: Float = 0
    if let channel = buffer.floatChannelData?[0] {
      for index in 0..<Int(buffer.frameLength) {
        peak = max(peak, abs(channel[index]))
      }
    }
    lock.lock()
    defer { lock.unlock() }
    level = peak
    guard let file, let converter else { return }
    let ratio = segmentFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: segmentFormat, frameCapacity: capacity) else {
      return
    }
    var consumed = false
    var conversionError: NSError?
    // `noDataNow` keeps the resampler's state between taps instead of ending the stream.
    converter.convert(to: output, error: &conversionError) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, output.frameLength > 0 else { return }
    do {
      try file.write(from: output)
      segmentFrames += AVAudioFramePosition(output.frameLength)
      segmentPeak = max(segmentPeak, peak)
    } catch {
      self.file = nil
    }
  }

  func beginSegment() throws {
    guard running, engine.isRunning else {
      throw NSError(
        domain: "T3VoiceCapture", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The microphone isn't running."])
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(UUID().uuidString).wav")
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: segmentFormat.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    let next = try AVAudioFile(
      forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    lock.lock()
    let previous = fileURL
    converter?.reset()
    file = next
    fileURL = url
    segmentFrames = 0
    segmentPeak = 0
    lock.unlock()
    if let previous { try? FileManager.default.removeItem(at: previous) }
  }

  /// The finished segment; JavaScript deletes its file once transcribed.
  func endSegment() -> [String: Any] {
    lock.lock()
    let url = fileURL
    let frames = segmentFrames
    let peak = segmentPeak
    let finished = file
    file = nil
    fileURL = nil
    lock.unlock()
    if #available(iOS 18.0, *) { finished?.close() }
    return [
      "uri": url?.absoluteString ?? NSNull(),
      "seconds": Double(frames) / segmentFormat.sampleRate,
      "peak": peak,
    ]
  }

  func cancelSegment() {
    if let uri = endSegment()["uri"] as? String, let url = URL(string: uri) {
      try? FileManager.default.removeItem(at: url)
    }
  }

  func status() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let disrupted = disruptedAt.map { Date().timeIntervalSince($0) < 1.5 } ?? false
    return [
      "running": running && engine.isRunning,
      "interrupted": interrupted,
      "suspect": suspect,
      "disrupted": disrupted,
      "level": level,
      "recording": file != nil,
    ]
  }

  func stop() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    removeEngineObserver()
    running = false
    interrupted = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    lock.lock()
    suspect = false
    disruptedAt = nil
    file = nil
    fileURL = nil
    converter = nil
    lock.unlock()
    clearDirectory()
  }

  private func clearDirectory() {
    try? FileManager.default.removeItem(at: directory)
  }
}

/// Picks the language dictation listens for: the thread's language and the locales Apple's
/// on-device recognizer offers.
enum T3DictationLanguage {
  /// The dominant language of the text as a BCP 47 tag, or nil when it is unclear.
  static func detect(_ text: String) -> String? {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let language = recognizer.dominantLanguage, language != .undetermined else { return nil }
    let confidence = recognizer.languageHypotheses(withMaximum: 1)[language] ?? 0
    return confidence >= 0.5 ? language.rawValue : nil
  }

  /// On-device recognizer locales, or `fallback` where there is no on-device recognizer, named
  /// in the device language.
  static func locales(fallback: [String]) async -> [[String: String]] {
    var identifiers = fallback
    if #available(iOS 26, *) {
      let supported = await SpeechTranscriber.supportedLocales
      if !supported.isEmpty {
        identifiers = supported.map { $0.identifier(.bcp47) }
      }
    }
    return identifiers.map { identifier in
      ["id": identifier, "name": Locale.current.localizedString(forIdentifier: identifier) ?? identifier]
    }
  }

  /// Locales whose on-device model is already on the phone, so preparing one starts no download.
  static func installedLocales() async -> [String] {
    guard #available(iOS 26, *) else { return [] }
    return await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
  }
}

public class T3VoiceCaptureModule: Module {
  private let capture = T3VoiceCapture()

  public func definition() -> ModuleDefinition {
    Name("T3VoiceCapture")

    Events("onStateChange")

    OnCreate {
      self.capture.onState = { [weak self] body in
        self?.sendEvent("onStateChange", body)
      }
    }

    OnDestroy {
      self.capture.stop()
    }

    AsyncFunction("start") {
      try self.capture.start()
    }.runOnQueue(.main)

    AsyncFunction("recover") {
      self.capture.recover()
    }.runOnQueue(.main)

    AsyncFunction("beginSegment") {
      try self.capture.beginSegment()
    }.runOnQueue(.main)

    AsyncFunction("endSegment") { () -> [String: Any] in
      self.capture.endSegment()
    }.runOnQueue(.main)

    AsyncFunction("cancelSegment") {
      self.capture.cancelSegment()
    }.runOnQueue(.main)

    Function("status") { () -> [String: Any] in
      self.capture.status()
    }

    AsyncFunction("stop") {
      self.capture.stop()
    }.runOnQueue(.main)

    Function("detectLanguage") { (text: String) -> String? in
      T3DictationLanguage.detect(text)
    }

    AsyncFunction("dictationLocales") { (fallback: [String]) async -> [[String: String]] in
      await T3DictationLanguage.locales(fallback: fallback)
    }

    AsyncFunction("installedDictationLocales") { () async -> [String] in
      await T3DictationLanguage.installedLocales()
    }
  }
}
