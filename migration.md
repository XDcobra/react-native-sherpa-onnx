# Implementierungsplan: SDK/App Release, Ads, Play Store

## Ziele und Leitplanken
- SDK bleibt Open Source; Beispiel-App kann werbefinanziert im Play Store erscheinen.
- Debug-Artefakte aus CI (APK/IPA) bleiben werbefrei und verwenden nur Test-IDs.
- Produktions-Ads und Secrets kommen ausschliesslich aus GitHub Secrets.
- iOS fuer App-Release vorerst ignorieren; Android AAB + Fastlane fuer Closed Testing.
- Tag-Struktur trennt SDK-Release von App-Release.

## Tag- und Release-Strategie
### Tag-Namensschema
- SDK Releases: `sdk-vX.Y.Z`
- App Releases: `app-vX.Y.Z`

### Konsequenzen fuer release-it
- `yarn release` soll weiterhin SDK veroeffentlichen.
- release-it Tag-Namen auf `sdk-v${version}` umstellen.
- GitHub Release fuer SDK bleibt aktiv; App-Release getrennt ueber eigenen Workflow.

## Workflow-Architektur
### Bestehende Workflows (Debug)
- Debug Builds bleiben in `android.yml` und `ios.yml`.
- Debug: keine Ads, Test-IDs, Debug-Artefakte als GitHub Release Assets (wie bisher).

### Neuer App-Release-Workflow (Android only)
- Triggert auf `app-v*` Tags.
- Baut signiertes AAB.
- Laedt AAB als Artifact hoch.
- Verwendet Fastlane zum Upload in Play Store Closed Testing.

## Secrets-Management (GitHub Secrets)
### Erforderliche Secrets
- `ADMOB_APP_ID_ANDROID`
- `ADMOB_BANNER_ID_ANDROID` (oder entsprechende Ad Units)
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `FASTLANE_JSON_KEY` (Play Developer API)

### Anforderungen
- Keine AdMob IDs oder Keys im Repo.
- Debug-Workflow darf keine Secrets benoetigen.
- App-Release-Workflow verwendet Secrets ausschliesslich in Release-Builds.

## App-Konfiguration (Debug vs Release)
### Build-Varianten
- Android Product Flavors oder Build Types:
	- `debug`: Ads deaktiviert, Test-IDs, kein Consent notwendig.
	- `release`: Ads aktiviert, echte IDs aus Secrets, Consent verpflichtend.

### Konfigurationsweitergabe
- Release-Workflow injiziert IDs per Gradle/ENV.
- Debug-Defaults im Code oder Gradle fuer Test-IDs.

## GDPR/Consent (Android)
- Consent SDK integrieren (UMP).
- AdMob initialisieren erst nach Consent.
- Fail-safe: Ohne Consent keine Ads.

## Play Store Release (Android)
- Build signiert erzeugen (AAB).
- Fastlane `supply` fuer Closed Testing.
- Track/Release Notes vorbereiten.

## Implementierungsphasen
### Phase 1: Planung und Architektur
- Tag-Struktur finalisieren und dokumentieren.
- Workflow-Aufteilung definieren (Debug vs App Release).
- Secrets-Liste finalisieren.

### Phase 2: SDK Release Anpassung
- release-it Tag-Format auf `sdk-v${version}` anpassen.
- Sicherstellen: `yarn release` triggert nur SDK-Workflow.

### Phase 3: App Release Workflow (Android)
- Neuer Workflow fuer `app-v*` Tags.
- Signierung + AAB + Artifact Upload.
- Fastlane Upload Closed Testing.

### Phase 4: App Build-Varianten
- Debug vs Release Flags fuer Ads.
- Test-IDs in Debug.
- Release-IDs per Secrets.

### Phase 5: GDPR/Consent
- Consent SDK integrieren.
- Ads nur nach Consent laden.
- QA Check: Kein Ad Request ohne Consent.

### Phase 6: Verifikation
- Debug-Workflow: keine Ads, Test-IDs, Artefakte wie bisher.
- Release-Workflow: signiertes AAB, Upload erfolgreich.
- Secrets nicht im Repo.

## Checkliste vor Umsetzung
- [x] Tag-Schema final und mit Team abgestimmt.
- [x] release-it fuer SDK angepasst.
- [x] Neuer App-Release-Workflow definiert.
- [x] Alle Secrets in GitHub gesetzt.
- [x] Debug/Release Ad-Logik klar getrennt.
- [x] Consent-Flows definiert.
- [ ] Fastlane Zugang getestet.

## Risiken und Gegenmassnahmen
- Risiko: Falscher Workflow wird bei Tag getriggert.
	- Gegenmassnahme: Eindeutige Tag-Praefox und Workflow Filter.
- Risiko: Ads werden in Debug geladen.
	- Gegenmassnahme: Hard disable in Debug BuildType/Flavor.
- Risiko: Secrets im Log.
	- Gegenmassnahme: Maskierung und keine echo-Ausgaben.

## Notizen
- iOS App-Release ist bewusst ausgenommen.
- Debug-Artefakte bleiben frei von Werbung.
- Keine Secrets im Repo; alles ueber GitHub Secrets.
