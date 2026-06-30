// Removes the `aps-environment` (Push Notifications) entitlement so the app can
// be signed by a free/personal Apple Developer team, which is not allowed to use
// Push Notifications. expo-notifications is an auto-applied plugin and re-adds the
// entitlement after app.json plugins run, so we strip it from the written
// entitlements file in a dangerous mod (which runs after the file is generated).
//
// Remove this plugin once a paid Apple Developer account is active and you want
// real remote push notifications back.
const fs = require('fs')
const path = require('path')
const { withDangerousMod } = require('expo/config-plugins')

module.exports = function withoutPushEntitlement(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const iosRoot = config.modRequest.platformProjectRoot
      // Find the .entitlements file (named after the target, e.g. Sentry.entitlements)
      const findEntitlements = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory() && entry.name !== 'Pods' && entry.name !== 'build') {
            const found = findEntitlements(full)
            if (found) return found
          } else if (entry.name.endsWith('.entitlements')) {
            return full
          }
        }
        return null
      }

      const file = findEntitlements(iosRoot)
      if (file) {
        let contents = fs.readFileSync(file, 'utf8')
        contents = contents.replace(
          /\s*<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/,
          ''
        )
        fs.writeFileSync(file, contents)
      }
      return config
    },
  ])
}
