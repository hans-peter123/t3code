import AVFoundation
import ExpoModulesCore

/// iOS hands a recording that starts in the background only silence, so hands-free mode starts one
/// microphone input in the foreground, keeps it running, and saves only the spans it asks for.
/// The audio session itself is configured from JavaScript (playAndRecord, background).
final class T3VoiceCapture {
  private let engine = AVAudioEngine()
  private let lock = NSLock()
  private var file: AVAudioFile?
  private var fileURL: URL?
  private var segmentFrames: AVAudioFramePosition = 0
  private var segmentPeak: Float = 0
  private var level: Float = 0
  private var running = false
  private var configurationObserver: NSObjectProtocol?

  func start() throws {
    if running { return }
    try installTapAndStart()
    running = true
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      // A route change (car, AirPods) stops the engine; restart it on the new input.
      guard let self, self.running else { return }
      self.engine.inputNode.removeTap(onBus: 0)
      try? self.installTapAndStart()
    }
  }

  private func installTapAndStart() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.receive(buffer)
    }
    engine.prepare()
    try engine.start()
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
    guard let file else { return }
    do {
      try file.write(from: buffer)
      segmentFrames += AVAudioFramePosition(buffer.frameLength)
      segmentPeak = max(segmentPeak, peak)
    } catch {
      self.file = nil
    }
  }

  func beginSegment(path: String) throws {
    let format = engine.inputNode.outputFormat(forBus: 0)
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: format.channelCount,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    let next = try AVAudioFile(
      forWriting: url,
      settings: settings,
      commonFormat: format.commonFormat,
      interleaved: format.isInterleaved
    )
    lock.lock()
    file = next
    fileURL = url
    segmentFrames = 0
    segmentPeak = 0
    lock.unlock()
  }

  func endSegment() -> [String: Any] {
    lock.lock()
    let url = fileURL
    let frames = segmentFrames
    let peak = segmentPeak
    let sampleRate = file?.processingFormat.sampleRate ?? 0
    file = nil
    fileURL = nil
    lock.unlock()
    return [
      "uri": url?.absoluteString ?? NSNull(),
      "seconds": sampleRate > 0 ? Double(frames) / sampleRate : 0,
      "peak": peak,
    ]
  }

  func status() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return ["running": running && engine.isRunning, "level": level, "recording": file != nil]
  }

  func stop() {
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
    }
    configurationObserver = nil
    running = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    lock.lock()
    file = nil
    fileURL = nil
    lock.unlock()
  }
}

public class T3VoiceCaptureModule: Module {
  private let capture = T3VoiceCapture()

  public func definition() -> ModuleDefinition {
    Name("T3VoiceCapture")

    AsyncFunction("start") {
      try self.capture.start()
    }

    AsyncFunction("beginSegment") { (path: String) in
      try self.capture.beginSegment(path: path)
    }

    AsyncFunction("endSegment") { () -> [String: Any] in
      self.capture.endSegment()
    }

    Function("status") { () -> [String: Any] in
      self.capture.status()
    }

    AsyncFunction("stop") {
      self.capture.stop()
    }
  }
}
