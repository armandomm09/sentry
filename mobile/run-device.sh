#!/usr/bin/env bash
# Build & run Sentry on a physical iOS device with a FREE / personal Apple team.
#
# Why this exists: expo-notifications forces the Push Notifications
# (aps-environment) entitlement during `expo prebuild`, and free Apple developer
# teams are NOT allowed to sign apps that use Push Notifications. `expo run:ios`
# re-runs prebuild every time, so the entitlement keeps coming back and the build
# fails with "Personal development teams ... do not support the Push Notifications
# capability".
#
# This script prebuilds, strips that entitlement, builds a signed .app with
# xcodebuild targeting your connected device (a free-team provisioning profile
# must be bound to a specific device), then hands the binary to
# `expo run:ios --binary` which installs it and starts Metro WITHOUT re-prebuilding.
#
# Delete this script and plugins/withoutPushEntitlement.js once your paid Apple
# Developer account is active and you want real remote push back.
set -euo pipefail
cd "$(dirname "$0")"

# Free "Personal Team" id from Xcode > Settings > Accounts (NOT the cert org id).
TEAM="${APPLE_TEAM_ID:-42N9DHMT29}"
SCHEME="Sentry"
WORKSPACE="ios/Sentry.xcworkspace"
CONFIG="Debug"

echo "▸ Prebuilding iOS project…"
npx expo prebuild -p ios

echo "▸ Stripping push-notifications entitlement (free team can't sign it)…"
ENT="$(find ios -name '*.entitlements' -not -path '*/Pods/*' | head -1)"
if [ -n "$ENT" ]; then
  /usr/libexec/PlistBuddy -c "Delete :aps-environment" "$ENT" 2>/dev/null || true
  echo "  stripped: $ENT"
fi

echo "▸ Finding connected device…"
UDID="$(xcrun xctrace list devices 2>&1 \
  | grep -iE 'iPhone|iPad' | grep -iv 'Simulator' \
  | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40}' | head -1)"
if [ -z "$UDID" ]; then
  echo "  ✗ No physical device detected. Unlock your iPhone, plug it in, trust this Mac, and retry." >&2
  exit 1
fi
echo "  device: $UDID"

echo "▸ Building signed app for device (team $TEAM)…"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination "id=$UDID" \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  build

APP="ios/build/Build/Products/${CONFIG}-iphoneos/${SCHEME}.app"
echo "▸ Built: $APP"

echo "▸ Installing on device + starting Metro…"
npx expo run:ios --device --binary "$APP"
