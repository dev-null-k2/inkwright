import Capacitor
import UIKit

/// Capacitor's view controller with Inkwright's own iOS plugin registered.
class InkwrightBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(InkwrightApplePlugin())
    }
}
