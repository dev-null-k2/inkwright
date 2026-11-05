import Capacitor
import UIKit
import WebKit

/// Capacitor's view controller with Inkwright's own iOS plugin registered.
class InkwrightBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(InkwrightApplePlugin())
        // Paper colour (dark in dark mode) behind the web view until its first frame, so opening the
        // app never flashes white after the launch screen.
        let paper = UIColor(named: "LaunchBackground") ?? .systemBackground
        view.backgroundColor = paper
        webView?.isOpaque = false
        webView?.backgroundColor = paper
        webView?.scrollView.backgroundColor = paper
        #if DEBUG
        // The CI simulator run (scripts/ios/simulator-run.mjs) passes a walk through the app as
        // base64 JavaScript in INKWRIGHT_TOUR. Never present in release builds.
        if let b64 = ProcessInfo.processInfo.environment["INKWRIGHT_TOUR"],
           let data = Data(base64Encoded: b64), let js = String(data: data, encoding: .utf8) {
            NSLog("Inkwright: simulator tour injected (%d bytes)", js.utf8.count)
            webView?.configuration.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            if webView?.url != nil { webView?.evaluateJavaScript(js) }
        }
        #endif
    }
}
