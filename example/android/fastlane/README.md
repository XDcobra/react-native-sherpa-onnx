# Fastlane (Android)

This folder contains the Play Store upload lane for the example app.

## Local run

1) Export the JSON key from the Play Console service account:

```
export FASTLANE_JSON_KEY='{"type":"service_account",...}'
```

2) Install gems and run the lane:

```
cd example/android
bundle install
bundle exec fastlane closed_testing
```

Notes:
- The lane uploads the release AAB from app/build/outputs/bundle/release.
- The Play Store track is set to closed_testing.
