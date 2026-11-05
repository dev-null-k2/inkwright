import Capacitor
import UIKit
#if canImport(FoundationModels)
import FoundationModels
#endif

/// The iOS half of Inkwright's native features (apps/web/src/ai/apple/plugin.ts):
/// - Apple's on-device model (Foundation Models, iOS 26 and later, Apple Intelligence on), streamed
///   to the web app as `llmDelta` events. The web app owns prompting, tools and citations.
/// - Apple Pencil double-tap and squeeze, sent as `pencil` events so the pen-button setting applies.
@objc(InkwrightApplePlugin)
public class InkwrightApplePlugin: CAPPlugin, CAPBridgedPlugin, UIPencilInteractionDelegate {
    public let identifier = "InkwrightApplePlugin"
    public let jsName = "InkwrightApple"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tourSnapshot", returnType: CAPPluginReturnPromise),
    ]

    private var running: [String: Task<Void, Never>] = [:]

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.bridge?.webView else { return }
            let pencil = UIPencilInteraction()
            pencil.delegate = self
            view.addInteraction(pencil)
        }
    }

    // MARK: Apple Pencil

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        notifyListeners("pencil", data: ["action": "doubleTap"])
    }

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        if squeeze.phase == .ended { notifyListeners("pencil", data: ["action": "squeeze"]) }
    }

    public func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        notifyListeners("pencil", data: ["action": "doubleTap"])
    }

    // MARK: On-device model

    @objc func availability(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["state": "available"])
            case .unavailable(let reason):
                switch reason {
                case .modelNotReady: call.resolve(["state": "downloading", "reason": "modelNotReady"])
                case .appleIntelligenceNotEnabled: call.resolve(["state": "unavailable", "reason": "appleIntelligenceNotEnabled"])
                case .deviceNotEligible: call.resolve(["state": "unavailable", "reason": "deviceNotEligible"])
                @unknown default: call.resolve(["state": "unavailable", "reason": "unknown"])
                }
            }
            return
        }
        #endif
        call.resolve(["state": "unavailable", "reason": "osTooOld"])
    }

    @objc func generate(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let id = call.getString("id") ?? UUID().uuidString
            let messages: [JSObject] = call.getArray("messages", JSObject.self) ?? []
            let system = messages.filter { ($0["role"] as? String) == "system" }.compactMap { $0["content"] as? String }.joined(separator: "\n\n")
            let turns = messages.filter { ($0["role"] as? String) != "system" }
            // Earlier turns go into the prompt as a transcript; the last one is what to answer.
            var prompt = ""
            for (i, m) in turns.enumerated() {
                let text = (m["content"] as? String) ?? ""
                if i == turns.count - 1 { prompt += text; break }
                prompt += ((m["role"] as? String) == "assistant" ? "Assistant: " : "User: ") + text + "\n\n"
            }
            let temperature = call.getDouble("temperature")
            let maxTokens = call.getInt("maxTokens")
            let task = Task { [weak self] in
                do {
                    let session = LanguageModelSession(instructions: system)
                    let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
                    var sent = ""
                    for try await snapshot in session.streamResponse(to: prompt, options: options) {
                        let text = snapshot.content
                        if text.count > sent.count, text.hasPrefix(sent) {
                            self?.notifyListeners("llmDelta", data: ["id": id, "text": String(text.dropFirst(sent.count))])
                        }
                        sent = text
                    }
                    call.resolve(["text": sent])
                } catch is CancellationError {
                    call.reject("Cancelled", "CANCELLED")
                } catch {
                    call.reject(String(describing: error), "GENERATION_FAILED")
                }
                DispatchQueue.main.async { self?.running[id] = nil }
            }
            DispatchQueue.main.async { self.running[id] = task }
            return
        }
        #endif
        call.unavailable("Apple's on-device model needs iOS 26 with Apple Intelligence turned on.")
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        DispatchQueue.main.async {
            self.running[id]?.cancel()
            self.running[id] = nil
            call.resolve()
        }
    }

    // MARK: Simulator tour (debug builds only; scripts/ios/tour.js)

    /// Saves a picture of the web view as Documents/tour/<name>.png for the CI simulator run.
    @objc func tourSnapshot(_ call: CAPPluginCall) {
        #if DEBUG
        let name = (call.getString("name") ?? "snap").replacingOccurrences(of: "/", with: "-")
        DispatchQueue.main.async {
            guard let web = self.bridge?.webView else { call.reject("No web view"); return }
            web.takeSnapshot(with: nil) { image, error in
                guard let png = image?.pngData() else { call.reject(error.map { String(describing: $0) } ?? "No image"); return }
                do {
                    let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("tour", isDirectory: true)
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try png.write(to: dir.appendingPathComponent("\(name).png"))
                    call.resolve()
                } catch {
                    call.reject(String(describing: error))
                }
            }
        }
        #else
        call.unimplemented("Debug builds only")
        #endif
    }
}
