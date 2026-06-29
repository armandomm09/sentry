# Sentry Mobile App — Implementation Plan

**Branch:** feat/mobile-app
**Target directory:** /home/armandomm09/monitoreo_hogar/sentry/mobile/
**Stack:** React Native (Expo managed workflow), TypeScript, React Navigation

---

## Global Constraints

- Expo managed workflow — NO ejecting
- TypeScript everywhere (strict)
- React Navigation (bottom tabs + native stack), NOT expo-router
- AuthContext + SecureStore for auth state; no Redux/Zustand
- System fonts only (SF Pro on iOS, Roboto on Android) — no Google Fonts loaded
- Ionicons from @expo/vector-icons for all icons — NO emoji as icons
- All colors via a central design-tokens file (no raw hex in components)
- Touch targets ≥ 44pt (use hitSlop where visual element is smaller)
- Animations use react-native-reanimated — transform/opacity only, 150–300ms
- WebSocket protocol auto-swap: http:// → ws://, https:// → wss://
- Server URL normalized: trim trailing slash, accept with/without protocol prefix
- Graceful degradation: unreachable server shows "Reconnecting…" not a crash
- Target iOS and Android
- No comments except for non-obvious WHY

## Design Tokens (to implement in src/theme/tokens.ts)

```
Colors:
  primary:    #e83a29  (live badges, CTAs, alerts, active tab)
  bg:         #0f0f0f  (root background)
  surface1:   #1c1c1e  (cards, bottom tab bar)
  surface2:   #2c2c2e  (input fields, secondary surfaces)
  text:       #ffffff  (primary text)
  textMuted:  #8e8e93  (secondary text, captions)
  online:     #30d158  (green — live / connected)
  warning:    #ff9f0a  (amber — unknown person)
  danger:     #e83a29  (same as primary — alert / known)
  border:     #3a3a3c  (dividers)

Radii:    sm=8, md=12, lg=16, xl=24
Spacing:  xs=4, sm=8, md=16, lg=24, xl=32, xxl=48
FontSize: xs=11, sm=13, md=15, lg=17, xl=20, xxl=28, xxxl=34
FontWeight: regular=400, medium=500, semibold=600, bold=700
```

## Backend API Reference

- Base URL: stored in SecureStore key "sentry_base_url"
- Auth token: stored in SecureStore key "sentry_token"
- All requests: `Authorization: Bearer <token>` header

Endpoints:
- POST /api/auth/login  { username, password } → { token, user_id, username }
- POST /api/auth/logout
- GET  /api/cameras     → [{ id, name, location, rtsp_url, face_recognition, auto_reconnect }]
- GET  /api/streams     → { [camera_id]: { status, hls_url, error } }
- GET  /api/face/persons → [{ id, name, photo_count }]
- POST /api/push/register { expo_push_token, camera_ids, notify_known, notify_unknown }
- GET  /api/push/subscription
- DELETE /api/push/subscription

WebSockets:
- ws://{host}/api/cameras/{id}/frames  — binary JPEG frames ~10fps
- ws://{host}/api/face/cameras/{id}/ws — JSON detection events
  Message: { type:"detections", camera_id, ts, detections:[{ person_id, name, score, bbox:[x1,y1,x2,y2] }] }

---

## Task 1 — Scaffold + Dependencies

**Goal:** Create the Expo app and install all required dependencies.

Steps:
1. `npx create-expo-app@latest mobile --template blank-typescript` inside /home/armandomm09/monitoreo_hogar/sentry/
2. cd mobile
3. Install: expo-secure-store expo-notifications expo-device
4. Install: @react-navigation/native @react-navigation/bottom-tabs @react-navigation/native-stack
5. Install: react-native-screens react-native-safe-area-context
6. Install: @expo/vector-icons (already in Expo, verify)
7. Install: react-native-reanimated
8. Verify package.json has all dependencies
9. Write app.json with:
   - name: "Sentry", slug: "sentry-home", version: "1.0.0"
   - platforms: ["ios","android"]
   - icon: "./assets/icon.png", splash configured
   - plugins: ["expo-secure-store", "expo-notifications"]
   - android: { package: "com.sentry.home" }
   - ios: { bundleIdentifier: "com.sentry.home" }
10. Write eas.json with development, preview, production profiles
11. git add + commit

**Deliverable:** Working `npx expo start` (no TypeScript errors on blank app)

---

## Task 2 — Design Tokens + Auth Context + API Client

**Goal:** Foundation layer that all screens depend on.

Files to create:
- `src/theme/tokens.ts` — all design tokens (colors, radii, spacing, fontSize, fontWeight)
- `src/context/AuthContext.tsx` — auth state, login/logout, baseUrl
- `src/api/client.ts` — typed fetch wrapper, all API calls

### AuthContext shape:
```typescript
type AuthState = {
  token: string | null
  username: string | null
  baseUrl: string | null
  isLoading: boolean   // true while checking SecureStore on startup
}
type AuthContextType = AuthState & {
  login: (baseUrl: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}
```

SecureStore keys: "sentry_token", "sentry_username", "sentry_base_url"

On startup: read all three keys; if token exists, set auth state (don't re-validate — let API calls fail naturally).

login():
1. Normalize baseUrl: trim trailing slash, add https:// if no protocol
2. POST /api/auth/login
3. On success: store all three keys, update state
4. On failure: throw Error with message from response or "Connection failed"

logout():
1. POST /api/auth/logout (fire-and-forget, ignore errors)
2. Delete all three SecureStore keys
3. Clear auth state

### API client (src/api/client.ts):
```typescript
// All functions take baseUrl + token as params (from AuthContext)
// Return typed responses; throw on non-2xx

export async function getCameras(baseUrl: string, token: string): Promise<Camera[]>
export async function getStreams(baseUrl: string, token: string): Promise<StreamMap>
export async function getPersons(baseUrl: string, token: string): Promise<Person[]>
export async function registerPush(baseUrl: string, token: string, payload: PushRegistration): Promise<void>
export async function getPushSubscription(baseUrl: string, token: string): Promise<PushSubscription | null>
export async function deletePushSubscription(baseUrl: string, token: string): Promise<void>

// Types:
type Camera = { id: string; name: string; location: string; rtsp_url: string; face_recognition: boolean; auto_reconnect: boolean }
type StreamStatus = { status: 'live' | 'reconnecting'; hls_url: string; error?: string }
type StreamMap = Record<string, StreamStatus>
type Person = { id: string; name: string; photo_count: number }
type PushRegistration = { expo_push_token: string; camera_ids: string[]; notify_known: boolean; notify_unknown: boolean }
type PushSubscription = { expo_push_token: string; camera_ids: string[]; notify_known: boolean; notify_unknown: boolean }
```

Commit when done.

---

## Task 3 — WebSocket Hooks

**Goal:** Two reusable hooks for the live stream and detection feed.

### src/hooks/useCameraStream.ts
```typescript
function useCameraStream(cameraId: string | null): {
  frameUri: string | null   // data:image/jpeg;base64,... or null
  connected: boolean
  error: string | null
}
```
- Build WS URL from baseUrl in AuthContext: swap http(s):// → ws(s)://
- `ws.binaryType = 'arraybuffer'`
- onmessage: decode Uint8Array → base64 string → set frameUri
- Reconnect on close/error with 2s delay (only if cameraId still mounted)
- Add `Authorization: Bearer <token>` header to WebSocket constructor options
- Clean up (ws.close()) on unmount or cameraId change
- Use useRef for ws instance; useState only for frameUri/connected/error

### src/hooks/useDetections.ts
```typescript
type Detection = {
  id: string           // generated uuid or `${ts}-${person_id}`
  cameraId: string
  cameraName: string   // resolved from cameras list
  personId: string | null
  name: string         // "Unknown" if person_id null
  score: number        // 0-1
  bbox: [number, number, number, number]
  ts: string           // ISO string
}

function useDetections(cameraIds: string[]): {
  detections: Detection[]     // latest 100, newest first
  clearDetections: () => void
}
```
- Opens one WS per cameraId
- Appends incoming detections to state, capped at 100 entries
- Resolves camera name from cameras stored in a module-level cache (pass cameras array as param or read from a context)
- Reconnect logic same as useCameraStream
- Clean up all sockets on unmount

Commit when done.

---

## Task 4 — Navigation Shell

**Goal:** App entry point, navigation structure, and routing.

Files:
- `App.tsx` — root component, wraps everything in SafeAreaProvider + AuthProvider + NavigationContainer
- `src/navigation/AppNavigator.tsx` — root navigator (auth gate)
- `src/navigation/MainTabNavigator.tsx` — bottom tab navigator (4 tabs)
- `src/navigation/types.ts` — typed navigation params

### Navigation structure:
```
Root Stack (AppNavigator):
  if !token → LoginScreen
  if token  → MainTabNavigator
    Tab 1: Home (HomeStack)
      HomeScreen
      CameraDetailScreen  { cameraId: string, cameraName: string }
    Tab 2: Alerts
      AlertsScreen
    Tab 3: Persons
      PersonsScreen
    Tab 4: Settings
      SettingsScreen
```

### Bottom tab bar styling:
- Background: surface1 (#1c1c1e)
- Active tint: primary (#e83a29)
- Inactive tint: textMuted (#8e8e93)
- Border top: border (#3a3a3c)
- Tab icons (Ionicons): Home=home, Alerts=notifications, Persons=people, Settings=settings-sharp
- No tab labels visible (icon only — add accessibilityLabel for a11y)
- Alerts tab shows red badge dot when new alerts arrive (connect later)
- Header style: bg #0f0f0f, title white, no shadow

Each screen file should just be a placeholder that renders its name in white text centered on #0f0f0f background — real implementations come in later tasks.

Commit when done.

---

## Task 5 — Login Screen

**Goal:** Implement LoginScreen.tsx — fully functional login.

File: `src/screens/LoginScreen.tsx`

### Layout (top to bottom, vertically centered in ScrollView):
1. **Logo area** — a large shield icon (Ionicons "shield-checkmark") at size 72, color primary (#e83a29), centered, with "SENTRY" text below in size 28 bold white, letter-spacing 8
2. **Tagline** — "Home Security Intelligence" in textMuted, size 13, centered, marginBottom 48
3. **Form card** (surface1 bg, radius 16, padding 24):
   - Server URL field: label "Server URL", placeholder "http://192.168.1.100:8080"
   - Username field: label "Username", placeholder "admin"
   - Password field: label "Password", secureTextEntry, show/hide toggle (eye icon)
   - All inputs: surface2 bg (#2c2c2e), white text, radius 12, height 52, paddingH 16, border 1px border color
   - Labels above inputs in textMuted size 13
4. **Connect button**: full width, height 56, bg primary (#e83a29), radius 14, bold white "Connect to Sentry" size 17
   - Show ActivityIndicator (white) when loading, disable interaction
5. **Error message**: below button, text in #ff6b6b (lighter red for readability), size 13, centered
6. Keyboard-aware (KeyboardAvoidingView, behavior 'padding' on iOS)

Behavior:
- On submit: call `login(serverUrl, username, password)` from AuthContext
- On success: navigation handles redirect automatically (AppNavigator)
- On error: show error message from thrown Error
- Auto-focus username after server URL filled
- "Go" return key type on password field triggers submit
- Input type: url for server URL, default for username, none keyboard for password (textContentType: username/password for autofill)

Commit when done.

---

## Task 6 — Home Screen (Camera List)

**Goal:** Implement HomeScreen + CameraCard component.

Files:
- `src/screens/HomeScreen.tsx`
- `src/components/CameraCard.tsx`
- `src/components/PulsingBadge.tsx`

### HomeScreen:
- FlatList of cameras (2-column grid on wide screens, 1-column on narrow)
- Pull-to-refresh (calls getCameras + getStreams)
- Header title: "Sentry" in bold 28, left-aligned
- Sub-header: "{n} cameras" in textMuted
- Loading state: 3 skeleton cards (animated shimmer — gray surface2 with opacity pulsing via Reanimated)
- Empty state: shield icon + "No cameras configured" text + "Check your server connection" sub-text
- On camera tap: navigate to CameraDetailScreen with cameraId + cameraName

### CameraCard (src/components/CameraCard.tsx):
```
Card: surface1 bg, radius 16, padding 16, marginBottom 12
┌────────────────────────────────────┐
│ [camera icon 32px]   Name bold 17  │
│ [PulsingBadge]       Location 13   │
│ LIVE / OFFLINE       textMuted     │
└────────────────────────────────────┘
```
- Camera icon: Ionicons "videocam" in primary if live, textMuted if offline
- Status badge: green "LIVE" with PulsingBadge OR gray "OFFLINE"
- Press feedback: scale 0.97 on press (Reanimated withSpring)

### PulsingBadge (src/components/PulsingBadge.tsx):
- Small circle (8px) in online color (#30d158)
- Reanimated infinite loop: scale 1→1.6, opacity 1→0, 1200ms, easeOut
- Paired with "LIVE" text (green, size 11, semibold)
- Respects useReducedMotion (static dot if reduced motion)

Commit when done.

---

## Task 7 — Camera Detail Screen + Live Stream

**Goal:** Implement CameraDetailScreen and LiveStreamView component.

Files:
- `src/screens/CameraDetailScreen.tsx`
- `src/components/LiveStreamView.tsx`
- `src/components/DetectionCard.tsx`

### CameraDetailScreen layout:
```
┌──────────────────────────────────────┐
│  ← [Camera Name]                     │  ← native stack header
├──────────────────────────────────────┤
│                                      │
│         LiveStreamView               │  16:9 aspect ratio, full width
│                                      │
├──────────────────────────────────────┤
│ Detections  •  [count] events        │  section header
├──────────────────────────────────────┤
│  [DetectionCard]                     │
│  [DetectionCard]                     │  FlatList, scrollable
│  ...                                 │
└──────────────────────────────────────┘
```

### LiveStreamView (src/components/LiveStreamView.tsx):
- Uses useCameraStream hook
- Renders Image with uri=frameUri, resizeMode="cover", width=full, aspectRatio=16/9
- Overlay (absolute, top) — frosted-glass pill (semi-transparent bg, radius 20, padding 8 16):
  camera name + live indicator dot (green if connected, red if not)
- While frameUri is null: black bg with centered ActivityIndicator (white)
- If error: black bg with "Connection lost" text + Ionicons "wifi-outline" icon
- Image key tied to cameraId so it resets when camera changes

### DetectionCard (src/components/DetectionCard.tsx):
```
Card: surface1 bg, radius 12, padding 12, marginV 4, marginH 16
[Person icon 36px]  Name (bold 15)    [time ago, textMuted 13]
                    Camera name (13)
                    Confidence: 94%
```
- Known person: icon=person-circle, icon color=primary (#e83a29), name in white
- Unknown: icon=help-circle, icon color=warning (#ff9f0a), name="Unknown" in warning color
- Slide-in from right animation on mount (Reanimated: translateX 60→0, opacity 0→1, 250ms)
- Time display: "Just now" (<60s), "2m ago", "1h ago", etc.

Detection feed: useDetections([ cameraId ]) — show only detections for this camera.

Commit when done.

---

## Task 8 — Alerts Feed Screen

**Goal:** Implement AlertsScreen.

File: `src/screens/AlertsScreen.tsx`

Uses the same useDetections hook from Task 3, but passes ALL camera IDs so it buffers detections from all cameras. The hook already caps at 100.

### Layout:
- SectionList grouped by time period:
  - "Just Now" — detections within the last 5 minutes
  - "Today" — older than 5m but today
  - "Yesterday" — yesterday
  - (older detections fall off at 100 cap)
- Section headers: textMuted size 12 semibold, uppercase, paddingH 16, paddingV 8
- Each row: same DetectionCard layout as Task 7 (reuse the component)
- Empty state: Ionicons "notifications-off-outline" (48px, textMuted) + "No alerts yet" + "Detections will appear here in real time"
- When a new detection arrives while the user is on a different tab, show red dot badge on the Alerts tab icon — pass a callback or use a shared context

### Badge logic:
- Keep a ref `lastSeenCount` in AlertsScreen
- When new detections arrive and AlertsScreen is NOT focused, increment `unreadCount`
- When user navigates to Alerts tab, reset unreadCount to 0
- Pass unreadCount up via a simple callback prop to the tab navigator

Commit when done.

---

## Task 9 — Persons Screen

**Goal:** Implement PersonsScreen.

File: `src/screens/PersonsScreen.tsx`

### Layout:
- Search bar at top (surface2 bg, radius 12, height 44, magnifying glass icon in textMuted)
- FlatList of persons (filtered by search query)
- Loading skeleton (3 rows)
- Pull to refresh

### Person row:
```
[Avatar circle 48px]  Name (bold 15)           →
                      {n} photos enrolled (13, textMuted)
```
- Avatar: circle bg surface2, centered initial letter(s) of name in primary color, size 20 bold
- Divider line between rows (border color)
- Read-only — no tap action needed (show a brief toast "Manage persons on the web dashboard" if tapped)

### Empty state:
- Ionicons "people-outline" (48px) + "No persons enrolled" + "Enroll persons from the web dashboard"

Commit when done.

---

## Task 10 — Settings Screen + Push Notifications

**Goal:** Implement SettingsScreen with full push notification flow.

File: `src/screens/SettingsScreen.tsx`

### Layout — grouped list sections:

**Section: Push Notifications**
- Row: "Push Notifications" + Switch (tinted primary when on)
  When toggled ON:
    1. Call Notifications.requestPermissionsAsync()
    2. If denied: show Alert "Permission denied — enable notifications in Settings", revert switch
    3. If granted: call Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })
    4. POST to /api/push/register with token + current preferences (all cameras, notify_known=true, notify_unknown=true as defaults)
    5. Store "sentry_push_enabled"="1" in SecureStore
  When toggled OFF:
    1. DELETE /api/push/subscription
    2. Delete SecureStore key
- Sub-section (visible only when push enabled): "Notify for Known Persons" switch + "Notify for Unknown Persons" switch
- Sub-section (visible only when push enabled): Per-camera toggles for notification (list of cameras with Switch per row)
  - Changing any toggle calls /api/push/register again with updated preferences

**Section: Account**
- Row: "Username" — right-side value text in textMuted (from AuthContext)
- Row: "Server" — right-side value text in textMuted (baseUrl from AuthContext)
- Row: "Sign Out" — text in primary (#e83a29), tap shows confirmation Alert, then calls logout()

**Section: App**
- Row: "Version" — right-side "1.0.0" in textMuted

### Row style:
- bg surface1, height 52, paddingH 16
- Divider between rows within section (border, inset left 16)
- Section header: textMuted size 12 semibold uppercase, marginTop 32 marginBottom 8 paddingH 16

### In-app notification banner:
- When app is in foreground, show an in-app banner at top (similar to iOS banner)
  - Small bar: primary bg, camera name + person name + message, auto-dismiss 4s
  - Implement in App.tsx using Notifications.addNotificationReceivedListener

Commit when done.

---

## Task 11 — Polish + app.json + eas.json + Final Wiring

**Goal:** Final integration, config files, and minor polish pass.

Steps:
1. Wire unreadCount badge from AlertsScreen to the Alerts tab icon in MainTabNavigator
   - Use a simple React state in MainTabNavigator, passed down via a callback
2. Verify App.tsx correctly:
   - Wraps with SafeAreaProvider, NavigationContainer, AuthProvider
   - Registers Notifications.addNotificationReceivedListener for foreground banners
   - Sets status bar style to 'light'
3. Update app.json:
   - Confirm all fields from Task 1 are correct
   - Add `extra.eas.projectId` placeholder: "your-eas-project-id" (user fills in later)
4. Confirm eas.json has development (internal dist), preview (internal), production profiles
5. Add .gitignore entries for mobile/ node_modules and build artifacts if not already present
6. Run `npx tsc --noEmit` inside mobile/ and fix any type errors
7. Final commit

Deliverable: `cd mobile && npx expo start` works without errors.

---
