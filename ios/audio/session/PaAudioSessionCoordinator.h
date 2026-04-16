/**
 * PaAudioSessionCoordinator.h — Centralized AVAudioSession owner for pipeline audio.
 *
 * All mic/PCM feature code registers intents instead of directly manipulating AVAudioSession.
 * The coordinator computes the target profile (inactive/playback/duplex) and applies
 * category/mode/options/activation atomically. Thread-safe via serial dispatch queue.
 */

#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, PaAudioProfile) {
  PaAudioProfileInactive = 0,
  PaAudioProfilePlayback,
  PaAudioProfileDuplex,
};

// ── Intent ──────────────────────────────────────────────────────────────────

@interface PaAudioSessionIntent : NSObject
@property (nonatomic, copy) NSString *ownerId;   // "mic" or "pcm:<playerId>"
@property (nonatomic, assign) BOOL needsInput;
@property (nonatomic, assign) BOOL needsOutput;
+ (instancetype)intentWithOwnerId:(NSString *)ownerId
                       needsInput:(BOOL)needsInput
                      needsOutput:(BOOL)needsOutput;
@end

// ── Policy ──────────────────────────────────────────────────────────────────

@interface PaAudioSessionPolicy : NSObject <NSCopying>
@property (nonatomic, assign) BOOL keepActiveWhenIdle;
@property (nonatomic, assign) BOOL preferBluetoothForDuplex;     // default YES
@property (nonatomic, assign) BOOL defaultToSpeakerWhenDuplex;   // default YES
@property (nonatomic, copy, nullable) NSString *preferredInputDeviceId;
@property (nonatomic, copy, nullable) NSString *preferredOutputDeviceId;
@end

// ── Coordinator ─────────────────────────────────────────────────────────────

@interface PaAudioSessionCoordinator : NSObject

+ (instancetype)shared;

// Owner lifecycle
- (void)acquireIntent:(PaAudioSessionIntent *)intent;
- (void)releaseIntent:(NSString *)ownerId;

// Policy
- (BOOL)configurePolicy:(PaAudioSessionPolicy *)policy error:(NSError *_Nullable *_Nullable)error;

// Route preference (global)
- (BOOL)setRoutePreferenceInput:(nullable NSString *)inputId
                         output:(nullable NSString *)outputId
                          error:(NSError *_Nullable *_Nullable)error;
- (void)clearRoutePreference;

// Snapshot (JSON-serializable for bridge)
- (NSDictionary *)stateSnapshot;

// Module teardown
- (void)resetAll;

@end

NS_ASSUME_NONNULL_END
