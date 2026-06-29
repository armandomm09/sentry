import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'

import { useAuth } from '../context/AuthContext'
import {
  Camera,
  deletePushSubscription,
  getCameras,
  getPushSubscription,
  registerPush,
} from '../api/client'
import tokens from '../theme/tokens'

const PUSH_ENABLED_KEY = 'sentry_push_enabled'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return <Text style={styles.sectionHeader}>{title}</Text>
}

interface RowProps {
  label: string
  rightElement?: React.ReactNode
  onPress?: () => void
  isLast?: boolean
  labelStyle?: object
}

function Row({ label, rightElement, onPress, isLast, labelStyle }: RowProps): React.JSX.Element {
  const content = (
    <View style={[styles.row, !isLast && styles.rowWithBorder]}>
      <Text style={[styles.rowLabel, labelStyle]}>{label}</Text>
      {rightElement}
    </View>
  )

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    )
  }

  return content
}

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen(): React.JSX.Element {
  const { token, username, baseUrl, logout } = useAuth()

  const [cameras, setCameras] = useState<Camera[]>([])
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushToken, setPushToken] = useState<string | null>(null)
  const [notifyKnown, setNotifyKnown] = useState(true)
  const [notifyUnknown, setNotifyUnknown] = useState(true)
  const [cameraToggles, setCameraToggles] = useState<Record<string, boolean>>({})
  const [isBusy, setIsBusy] = useState(false)

  const isMounted = useRef(true)
  useEffect(() => {
    return () => {
      isMounted.current = false
    }
  }, [])

  // Fetch cameras on mount
  useEffect(() => {
    if (!baseUrl || !token) return
    void getCameras(baseUrl, token)
      .then(list => {
        if (!isMounted.current) return
        setCameras(list)
        // Initialize all camera toggles to true
        const initial: Record<string, boolean> = {}
        list.forEach(c => { initial[c.id] = true })
        setCameraToggles(initial)
      })
      .catch(() => undefined)
  }, [baseUrl, token])

  // Restore push state from SecureStore + server on mount
  useEffect(() => {
    if (!baseUrl || !token) return
    void (async () => {
      const stored = await SecureStore.getItemAsync(PUSH_ENABLED_KEY)
      if (stored === '1') {
        const sub = await getPushSubscription(baseUrl, token).catch(() => null)
        if (!isMounted.current) return
        if (sub) {
          setPushEnabled(true)
          setPushToken(sub.expo_push_token)
          setNotifyKnown(sub.notify_known)
          setNotifyUnknown(sub.notify_unknown)
          const toggles: Record<string, boolean> = {}
          sub.camera_ids.forEach(id => { toggles[id] = true })
          setCameraToggles(prev => ({ ...prev, ...toggles }))
        } else {
          // Server has no subscription; clear the stale key
          await SecureStore.deleteItemAsync(PUSH_ENABLED_KEY)
        }
      }
    })()
  }, [baseUrl, token])

  // Helper to push updated prefs to server
  const syncPushPrefs = useCallback(
    async (opts: {
      currentToken: string
      cameraIds: string[]
      known: boolean
      unknown: boolean
    }) => {
      if (!baseUrl || !token) return
      await registerPush(baseUrl, token, {
        expo_push_token: opts.currentToken,
        camera_ids: opts.cameraIds,
        notify_known: opts.known,
        notify_unknown: opts.unknown,
      })
    },
    [baseUrl, token],
  )

  // Enable push notifications
  const handleEnablePush = useCallback(async () => {
    if (isBusy) return
    setIsBusy(true)
    try {
      const { status } = await Notifications.requestPermissionsAsync()
      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'Enable notifications in your device Settings',
        )
        return
      }

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? 'your-eas-project-id'
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId })
      const expoPushToken = tokenData.data

      const cameraIds = cameras.map(c => c.id)
      await registerPush(baseUrl!, token!, {
        expo_push_token: expoPushToken,
        camera_ids: cameraIds,
        notify_known: true,
        notify_unknown: true,
      })

      await SecureStore.setItemAsync(PUSH_ENABLED_KEY, '1')

      if (!isMounted.current) return
      setPushToken(expoPushToken)
      setPushEnabled(true)
      setNotifyKnown(true)
      setNotifyUnknown(true)
      const toggles: Record<string, boolean> = {}
      cameras.forEach(c => { toggles[c.id] = true })
      setCameraToggles(toggles)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to enable notifications'
      Alert.alert('Error', message)
    } finally {
      if (isMounted.current) setIsBusy(false)
    }
  }, [baseUrl, cameras, isBusy, token])

  // Disable push notifications
  const handleDisablePush = useCallback(async () => {
    if (isBusy) return
    setIsBusy(true)
    try {
      await deletePushSubscription(baseUrl!, token!)
      await SecureStore.deleteItemAsync(PUSH_ENABLED_KEY)
      if (!isMounted.current) return
      setPushEnabled(false)
      setPushToken(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disable notifications'
      Alert.alert('Error', message)
    } finally {
      if (isMounted.current) setIsBusy(false)
    }
  }, [baseUrl, isBusy, token])

  const handlePushToggle = useCallback(
    (value: boolean) => {
      if (value) {
        void handleEnablePush()
      } else {
        void handleDisablePush()
      }
    },
    [handleDisablePush, handleEnablePush],
  )

  const handleNotifyKnownToggle = useCallback(
    (value: boolean) => {
      setNotifyKnown(value)
      if (!pushToken) return
      void syncPushPrefs({
        currentToken: pushToken,
        cameraIds: cameras.filter(c => cameraToggles[c.id]).map(c => c.id),
        known: value,
        unknown: notifyUnknown,
      }).catch(() => undefined)
    },
    [cameras, cameraToggles, notifyUnknown, pushToken, syncPushPrefs],
  )

  const handleNotifyUnknownToggle = useCallback(
    (value: boolean) => {
      setNotifyUnknown(value)
      if (!pushToken) return
      void syncPushPrefs({
        currentToken: pushToken,
        cameraIds: cameras.filter(c => cameraToggles[c.id]).map(c => c.id),
        known: notifyKnown,
        unknown: value,
      }).catch(() => undefined)
    },
    [cameras, cameraToggles, notifyKnown, pushToken, syncPushPrefs],
  )

  const handleCameraToggle = useCallback(
    (cameraId: string, value: boolean) => {
      const newToggles = { ...cameraToggles, [cameraId]: value }
      setCameraToggles(newToggles)
      if (!pushToken) return
      void syncPushPrefs({
        currentToken: pushToken,
        cameraIds: cameras.filter(c => newToggles[c.id]).map(c => c.id),
        known: notifyKnown,
        unknown: notifyUnknown,
      }).catch(() => undefined)
    },
    [cameras, cameraToggles, notifyKnown, notifyUnknown, pushToken, syncPushPrefs],
  )

  const handleSignOut = useCallback(() => {
    Alert.alert('Sign Out', 'Are you sure?', [
      { text: 'Cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => { void logout() },
      },
    ])
  }, [logout])

  // Build sub-rows for push section
  const pushSubRows: React.ReactNode[] = []
  if (pushEnabled) {
    pushSubRows.push(
      <Row
        key="notify-known"
        label="Notify for Known Persons"
        rightElement={
          <Switch
            value={notifyKnown}
            onValueChange={handleNotifyKnownToggle}
            thumbColor="#ffffff"
            trackColor={{ false: tokens.colors.surface2, true: tokens.colors.primary }}
          />
        }
      />,
    )
    pushSubRows.push(
      <Row
        key="notify-unknown"
        label="Notify for Unknown Persons"
        rightElement={
          <Switch
            value={notifyUnknown}
            onValueChange={handleNotifyUnknownToggle}
            thumbColor="#ffffff"
            trackColor={{ false: tokens.colors.surface2, true: tokens.colors.primary }}
          />
        }
      />,
    )
    cameras.forEach((camera, idx) => {
      pushSubRows.push(
        <Row
          key={`camera-${camera.id}`}
          label={camera.name}
          isLast={idx === cameras.length - 1}
          rightElement={
            <Switch
              value={cameraToggles[camera.id] ?? true}
              onValueChange={(v) => handleCameraToggle(camera.id, v)}
              thumbColor="#ffffff"
              trackColor={{ false: tokens.colors.surface2, true: tokens.colors.primary }}
            />
          }
        />,
      )
    })
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* PUSH NOTIFICATIONS SECTION */}
      <SectionHeader title="Push Notifications" />
      <View style={styles.sectionContainer}>
        <Row
          label="Push Notifications"
          isLast={!pushEnabled || cameras.length === 0}
          rightElement={
            <Switch
              value={pushEnabled}
              onValueChange={handlePushToggle}
              disabled={isBusy}
              thumbColor="#ffffff"
              trackColor={{ false: tokens.colors.surface2, true: tokens.colors.primary }}
            />
          }
        />
        {pushSubRows}
      </View>

      {/* ACCOUNT SECTION */}
      <SectionHeader title="Account" />
      <View style={styles.sectionContainer}>
        <Row
          label="Username"
          rightElement={
            <Text style={styles.rowValue}>{username ?? ''}</Text>
          }
        />
        <Row
          label="Server"
          rightElement={
            <Text style={[styles.rowValue, styles.rowValueSm]} numberOfLines={1}>
              {baseUrl ?? ''}
            </Text>
          }
        />
        <Row
          label="Sign Out"
          isLast
          onPress={handleSignOut}
          labelStyle={styles.signOutLabel}
        />
      </View>

      {/* APP SECTION */}
      <SectionHeader title="App" />
      <View style={styles.sectionContainer}>
        <Row
          label="Version"
          isLast
          rightElement={
            <Text style={styles.rowValue}>1.0.0</Text>
          }
        />
      </View>

      <View style={styles.bottomPad} />
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  contentContainer: {
    paddingBottom: 32,
  },
  sectionHeader: {
    color: tokens.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: 32,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  sectionContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: 16,
  },
  row: {
    backgroundColor: tokens.colors.surface1,
    height: 52,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowWithBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.colors.border,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    color: tokens.colors.text,
  },
  rowValue: {
    fontSize: 15,
    color: tokens.colors.textMuted,
  },
  rowValueSm: {
    fontSize: 13,
    flex: 1,
    textAlign: 'right',
    marginLeft: 16,
  },
  signOutLabel: {
    flex: 1,
    fontSize: 15,
    color: tokens.colors.primary,
    textAlign: 'center',
  },
  bottomPad: {
    height: 32,
  },
})
