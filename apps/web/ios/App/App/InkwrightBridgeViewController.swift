import Capacitor
import UIKit
import WebKit

/// Capacitor's view controller with Inkwright's own iOS plugin registered.
class InkwrightBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(InkwrightApplePlugin())
        #if DEBUG
        // The CI simulator run (scripts/ios/simulator-run.mjs) passes a walk through the app as
        // base64 JavaScript in INKWRIGHT_TOUR. Never present in release builds.
        if let b64 = ProcessInfo.processInfo.environment["INKWRIGHT_TOUR"],
           let data = Data(base64Encoded: b64), let js = String(data: data, encoding: .utf8) {
            webView?.configuration.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            if webView?.url != nil { webView?.evaluateJavaScript(js) }
        }
        #endif
    }
}
