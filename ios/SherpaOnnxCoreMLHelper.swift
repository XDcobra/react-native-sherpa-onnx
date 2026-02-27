/*
 * Core ML / Apple Neural Engine detection for getCoreMlSupport (AccelerationSupport).
 * Used only on iOS.
 */

import Foundation
import CoreML

@objc(SherpaOnnxCoreMLHelper)
public class SherpaOnnxCoreMLHelper: NSObject {

    /// True if the device reports Apple Neural Engine in Core ML compute devices (iOS 17+).
    @objc public static func hasAppleNeuralEngine() -> Bool {
        if #available(iOS 17.0, *) {
            for device in MLModel.availableComputeDevices {
                let typeName = String(describing: type(of: device))
                if typeName.contains("NeuralEngine") {
                    return true
                }
            }
        }
        return false
    }
}
