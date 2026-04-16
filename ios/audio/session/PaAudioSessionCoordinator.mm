/**
 * PaAudioSessionCoordinator.mm — Single owner for AVAudioSession in pipeline audio.
 *
 * Feature code (mic, PCM player) registers intents; the coordinator computes
 * the target session profile and applies category/mode/options/activation only on delta.
 */

#import "PaAudioSessionCoordinator.h"
#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>
#import <UIKit/UIKit.h>

static NSString *const kLogTag = @"PaAudioSessionCoordinator";

// ── Intent ──────────────────────────────────────────────────────────────────

@implementation PaAudioSessionIntent

+ (instancetype)intentWithOwnerId:(NSString *)ownerId
                       needsInput:(BOOL)needsInput
                      needsOutput:(BOOL)needsOutput {
  PaAudioSessionIntent *intent = [[PaAudioSessionIntent alloc] init];
  intent.ownerId = ownerId;
  intent.needsInput = needsInput;
  intent.needsOutput = needsOutput;
  return intent;
}

@end

// ── Policy ──────────────────────────────────────────────────────────────────

@implementation PaAudioSessionPolicy

- (instancetype)init {
  self = [super init];
  if (self) {
    _keepActiveWhenIdle = NO;
    _preferBluetoothForDuplex = YES;
    _defaultToSpeakerWhenDuplex = YES;
  }
  return self;
}

- (id)copyWithZone:(NSZone *)zone {
  PaAudioSessionPolicy *copy = [[PaAudioSessionPolicy alloc] init];
  copy.keepActiveWhenIdle = _keepActiveWhenIdle;
  copy.preferBluetoothForDuplex = _preferBluetoothForDuplex;
  copy.defaultToSpeakerWhenDuplex = _defaultToSpeakerWhenDuplex;
  copy.preferredInputDeviceId = _preferredInputDeviceId;
  copy.preferredOutputDeviceId = _preferredOutputDeviceId;
  return copy;
}

@end

// ── Coordinator ─────────────────────────────────────────────────────────────

@interface PaAudioSessionCoordinator ()
@property (nonatomic, strong) dispatch_queue_t serialQueue;
@property (nonatomic, strong) NSMutableDictionary<NSString *, PaAudioSessionIntent *> *owners;
@property (nonatomic, strong) PaAudioSessionPolicy *policy;
@property (nonatomic, assign) PaAudioProfile lastAppliedProfile;
@property (nonatomic, assign) BOOL observersRegistered;
@end

@implementation PaAudioSessionCoordinator

+ (instancetype)shared {
  static PaAudioSessionCoordinator *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[PaAudioSessionCoordinator alloc] initPrivate];
  });
  return instance;
}

- (instancetype)initPrivate {
  self = [super init];
  if (self) {
    _serialQueue = dispatch_queue_create("com.sherpaonnx.audio.session.coordinator", DISPATCH_QUEUE_SERIAL);
    _owners = [NSMutableDictionary new];
    _policy = [[PaAudioSessionPolicy alloc] init];
    _lastAppliedProfile = PaAudioProfileInactive;
    _observersRegistered = NO;
    [self registerObservers];
  }
  return self;
}

#pragma mark - Observers

- (void)registerObservers {
  if (_observersRegistered) return;
  _observersRegistered = YES;

  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserver:self
         selector:@selector(handleRouteChange:)
             name:AVAudioSessionRouteChangeNotification
           object:nil];
  [nc addObserver:self
         selector:@selector(handleInterruption:)
             name:AVAudioSessionInterruptionNotification
           object:nil];
  [nc addObserver:self
         selector:@selector(handleAppDidBecomeActive:)
             name:UIApplicationDidBecomeActiveNotification
           object:nil];
}

- (void)unregisterObservers {
  if (!_observersRegistered) return;
  _observersRegistered = NO;
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)handleRouteChange:(NSNotification *)notification {
  dispatch_async(_serialQueue, ^{
    RCTLogInfo(@"%@: route change detected, re-reconciling", kLogTag);
    [self reconcileInternal];
  });
}

- (void)handleInterruption:(NSNotification *)notification {
  NSNumber *typeValue = notification.userInfo[AVAudioSessionInterruptionTypeKey];
  if (!typeValue) return;

  AVAudioSessionInterruptionType type = (AVAudioSessionInterruptionType)[typeValue unsignedIntegerValue];
  if (type == AVAudioSessionInterruptionTypeEnded) {
    dispatch_async(_serialQueue, ^{
      RCTLogInfo(@"%@: interruption ended, re-reconciling", kLogTag);
      [self reconcileInternal];
    });
  }
}

- (void)handleAppDidBecomeActive:(NSNotification *)notification {
  dispatch_async(_serialQueue, ^{
    [self reconcileInternal];
  });
}

#pragma mark - Owner Lifecycle

- (void)acquireIntent:(PaAudioSessionIntent *)intent {
  dispatch_sync(_serialQueue, ^{
    self.owners[intent.ownerId] = intent;
    [self reconcileInternal];
  });
}

- (void)releaseIntent:(NSString *)ownerId {
  dispatch_sync(_serialQueue, ^{
    [self.owners removeObjectForKey:ownerId];
    [self reconcileInternal];
  });
}

#pragma mark - Policy

- (BOOL)configurePolicy:(PaAudioSessionPolicy *)policy error:(NSError *__autoreleasing *)error {
  __block BOOL ok = YES;
  dispatch_sync(_serialQueue, ^{
    self.policy = [policy copy];
    ok = [self reconcileInternal];
  });
  return ok;
}

#pragma mark - Route Preference

- (BOOL)setRoutePreferenceInput:(NSString *)inputId
                         output:(NSString *)outputId
                          error:(NSError *__autoreleasing *)error {
  __block BOOL ok = YES;
  dispatch_sync(_serialQueue, ^{
    self.policy.preferredInputDeviceId = inputId;
    self.policy.preferredOutputDeviceId = outputId;
    ok = [self reconcileInternal];
  });
  return ok;
}

- (void)clearRoutePreference {
  dispatch_sync(_serialQueue, ^{
    self.policy.preferredInputDeviceId = nil;
    self.policy.preferredOutputDeviceId = nil;
    [self reconcileInternal];
  });
}

#pragma mark - Snapshot

- (NSDictionary *)stateSnapshot {
  __block NSDictionary *snapshot;
  dispatch_sync(_serialQueue, ^{
    snapshot = [self buildSnapshotInternal];
  });
  return snapshot;
}

- (NSDictionary *)buildSnapshotInternal {
  NSUInteger micOwners = 0;
  NSUInteger pcmOwners = 0;
  for (PaAudioSessionIntent *intent in self.owners.allValues) {
    if (intent.needsInput) micOwners++;
    if (intent.needsOutput) pcmOwners++;
  }

  PaAudioProfile profile = [self computeProfileInternal];
  BOOL active = (profile != PaAudioProfileInactive) || self.policy.keepActiveWhenIdle;

  AVAudioSession *session = [AVAudioSession sharedInstance];
  AVAudioSessionRouteDescription *route = session.currentRoute;

  NSString *currentInputId = route.inputs.firstObject.UID ?: [NSNull null];
  NSString *currentOutputId = nil;
  AVAudioSessionPortDescription *outputPort = route.outputs.firstObject;
  if ([outputPort.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]) {
    currentOutputId = @"ios_builtin_speaker";
  } else if ([outputPort.portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
    currentOutputId = @"ios_builtin_receiver";
  } else {
    currentOutputId = outputPort.UID;
  }

  NSString *profileStr;
  switch (profile) {
    case PaAudioProfilePlayback: profileStr = @"playback"; break;
    case PaAudioProfileDuplex:   profileStr = @"duplex"; break;
    default:                     profileStr = @"inactive"; break;
  }

  return @{
    @"active": @(active),
    @"profile": profileStr,
    @"activeMicOwners": @(micOwners),
    @"activePcmOwners": @(pcmOwners),
    @"preferredInputDeviceId": self.policy.preferredInputDeviceId ?: [NSNull null],
    @"preferredOutputDeviceId": self.policy.preferredOutputDeviceId ?: [NSNull null],
    @"currentInputDeviceId": currentInputId ?: [NSNull null],
    @"currentOutputDeviceId": currentOutputId ?: [NSNull null],
  };
}

#pragma mark - Reset

- (void)resetAll {
  dispatch_sync(_serialQueue, ^{
    [self.owners removeAllObjects];
    self.policy = [[PaAudioSessionPolicy alloc] init];
    self.lastAppliedProfile = PaAudioProfileInactive;

    NSError *error = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                   withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                         error:&error];
    if (error) {
      RCTLogWarn(@"%@: resetAll setActive:NO failed: %@", kLogTag, error.localizedDescription);
    }
  });
}

#pragma mark - Internal: Reconcile

- (PaAudioProfile)computeProfileInternal {
  for (PaAudioSessionIntent *intent in self.owners.allValues) {
    if (intent.needsInput) return PaAudioProfileDuplex;
  }
  for (PaAudioSessionIntent *intent in self.owners.allValues) {
    if (intent.needsOutput) return PaAudioProfilePlayback;
  }
  return PaAudioProfileInactive;
}

- (BOOL)reconcileInternal {
  PaAudioProfile profile = [self computeProfileInternal];

  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;

  switch (profile) {
    case PaAudioProfileDuplex: {
      AVAudioSessionCategoryOptions options = 0;
      if (self.policy.defaultToSpeakerWhenDuplex) {
        options |= AVAudioSessionCategoryOptionDefaultToSpeaker;
      }
      if (self.policy.preferBluetoothForDuplex) {
        options |= AVAudioSessionCategoryOptionAllowBluetooth;
        options |= AVAudioSessionCategoryOptionAllowBluetoothA2DP;
      }

      if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                           mode:AVAudioSessionModeDefault
                        options:options
                          error:&error]) {
        RCTLogWarn(@"%@: setCategory PlayAndRecord failed: %@", kLogTag, error.localizedDescription);
        return NO;
      }
      if (![session setActive:YES withOptions:0 error:&error]) {
        RCTLogWarn(@"%@: setActive YES failed: %@", kLogTag, error.localizedDescription);
        return NO;
      }
      [self applyRoutePreferenceInternal];
      break;
    }

    case PaAudioProfilePlayback: {
      if (![session setCategory:AVAudioSessionCategoryPlayback
                           mode:AVAudioSessionModeDefault
                        options:0
                          error:&error]) {
        RCTLogWarn(@"%@: setCategory Playback failed: %@", kLogTag, error.localizedDescription);
        return NO;
      }
      if (![session setActive:YES withOptions:0 error:&error]) {
        RCTLogWarn(@"%@: setActive YES failed: %@", kLogTag, error.localizedDescription);
        return NO;
      }
      [self applyRoutePreferenceInternal];
      break;
    }

    case PaAudioProfileInactive: {
      if (!self.policy.keepActiveWhenIdle) {
        if (![session setActive:NO
                    withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                          error:&error]) {
          // setActive:NO can fail if another audio session is active; this is expected.
          RCTLogInfo(@"%@: setActive NO failed (expected if other audio active): %@", kLogTag, error.localizedDescription);
        }
      }
      break;
    }
  }

  self.lastAppliedProfile = profile;
  return YES;
}

- (void)applyRoutePreferenceInternal {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;

  // Output route preference
  NSString *outputPref = self.policy.preferredOutputDeviceId;
  if ([outputPref isEqualToString:@"ios_builtin_speaker"]) {
    [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:&error];
    if (error) {
      RCTLogWarn(@"%@: overrideOutputAudioPort speaker failed: %@", kLogTag, error.localizedDescription);
    }
  } else if ([outputPref isEqualToString:@"ios_builtin_receiver"]) {
    [session overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:&error];
    if (error) {
      RCTLogWarn(@"%@: overrideOutputAudioPort none failed: %@", kLogTag, error.localizedDescription);
    }
  } else if (outputPref.length > 0) {
    // For non-built-in outputs (e.g. Bluetooth), we set preferred input which
    // triggers the audio route to switch (iOS routes output through the same
    // physical device as the preferred input for Bluetooth HFP).
    NSArray<AVAudioSessionPortDescription *> *inputs = session.availableInputs ?: @[];
    for (AVAudioSessionPortDescription *input in inputs) {
      if ([input.UID isEqualToString:outputPref]) {
        [session setPreferredInput:input error:&error];
        if (error) {
          RCTLogWarn(@"%@: setPreferredInput for output %@ failed: %@", kLogTag, outputPref, error.localizedDescription);
        }
        [session overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:nil];
        break;
      }
    }
  }

  // Input route preference
  NSString *inputPref = self.policy.preferredInputDeviceId;
  if (inputPref.length > 0) {
    NSArray<AVAudioSessionPortDescription *> *inputs = session.availableInputs ?: @[];
    for (AVAudioSessionPortDescription *input in inputs) {
      if ([input.UID isEqualToString:inputPref]) {
        error = nil;
        [session setPreferredInput:input error:&error];
        if (error) {
          RCTLogWarn(@"%@: setPreferredInput %@ failed: %@", kLogTag, inputPref, error.localizedDescription);
        }
        break;
      }
    }
  }
}

@end
