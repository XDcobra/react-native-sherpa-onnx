/*
 * Core ML / Apple Neural Engine detection for getCoreMlSupport (AccelerationSupport).
 * Used only on iOS.
 */

import Foundation
import CoreML

@objc(SherpaOnnxCoreMLHelper)
public class SherpaOnnxCoreMLHelper: NSObject {

    /// True if the device reports Apple Neural Engine in Core ML compute devices (iOS 15+).
    @objc public static func hasAppleNeuralEngine() -> Bool {
        if #available(iOS 15.0, *) {
            return MLModel.availableComputeDevices.contains { device in
                device.type == .neuralEngine
            }
        }
        return false
    }
}
