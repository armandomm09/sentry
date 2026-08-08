import React, { useCallback, useLayoutEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { HomeStackParamList } from '../navigation/types'
import { createCamera, deleteCamera, updateCamera } from '../api/client'
import { useAuth } from '../context/AuthContext'
import FormField from '../components/FormField'
import tokens from '../theme/tokens'

type Props = NativeStackScreenProps<HomeStackParamList, 'CameraFormScreen'>

/**
 * Best-effort guess of a Hikvision/ISAPI snapshot URL from an RTSP URL.
 * `rtsp://user:pass@host:554/Streaming/Channels/102` →
 * `http://user:pass@host/ISAPI/Streaming/channels/102/picture`.
 * Returns '' when the input isn't a parseable rtsp:// URL.
 *
 * Mirrors deriveSnapshotUrl in the web dashboard so both clients guess alike.
 */
export function deriveSnapshotUrl(rtsp: string): string {
  const m = rtsp.trim().match(/^rtsps?:\/\/([^/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/i)
  if (!m) return ''
  const creds = m[1] ?? ''
  const host = m[2]
  const path = m[3] ?? ''
  const ch = /channels?\/(\d+)/i.exec(path)?.[1] ?? '101'
  return `http://${creds}${host}/ISAPI/Streaming/channels/${ch}/picture`
}

export default function CameraFormScreen({ route, navigation }: Props): React.JSX.Element {
  const { baseUrl, token } = useAuth()
  const existing = route.params?.camera
  const isEdit = existing !== undefined

  const [name, setName] = useState(existing?.name ?? '')
  const [location, setLocation] = useState(existing?.location ?? '')
  const [rtspUrl, setRtspUrl] = useState(existing?.rtsp_url ?? '')
  const [snapshotUrl, setSnapshotUrl] = useState(existing?.snapshot_url ?? '')
  // Once the user edits the snapshot field we stop re-deriving it from RTSP.
  const [snapshotTouched, setSnapshotTouched] = useState(isEdit)
  const [autoReconnect, setAutoReconnect] = useState(existing?.auto_reconnect ?? true)
  const [faceEnabled, setFaceEnabled] = useState(existing?.face_recognition_enabled ?? false)

  const [errors, setErrors] = useState<{ name?: string; rtspUrl?: string }>({})
  const [saving, setSaving] = useState(false)

  useLayoutEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit camera' : 'Add camera' })
  }, [navigation, isEdit])

  const handleRtspChange = useCallback((v: string) => {
    setRtspUrl(v)
    if (!snapshotTouched) setSnapshotUrl(deriveSnapshotUrl(v))
  }, [snapshotTouched])

  const handleSnapshotChange = useCallback((v: string) => {
    setSnapshotTouched(true)
    setSnapshotUrl(v)
  }, [])

  function validate(): boolean {
    const e: { name?: string; rtspUrl?: string } = {}
    if (!name.trim()) e.name = 'Name is required'
    if (!rtspUrl.trim()) {
      e.rtspUrl = 'Stream URL is required'
    } else if (!/^(rtsps?|wss?):\/\//i.test(rtspUrl.trim())) {
      e.rtspUrl = 'Must start with rtsp://, ws://, or wss://'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSave = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token || !validate()) return
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        location: location.trim(),
        rtsp_url: rtspUrl.trim(),
        snapshot_url: snapshotUrl.trim(),
        auto_reconnect: autoReconnect,
        face_recognition_enabled: faceEnabled,
      }
      if (isEdit) {
        await updateCamera(baseUrl, token, existing.id, payload)
      } else {
        await createCamera(baseUrl, token, payload)
      }
      navigation.goBack()
    } catch (err) {
      Alert.alert('Could not save', err instanceof Error ? err.message : 'Request failed')
    } finally {
      setSaving(false)
    }
    // validate() reads the latest state directly, so it is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token, name, location, rtspUrl, snapshotUrl, autoReconnect, faceEnabled, isEdit, existing, navigation])

  const handleDelete = useCallback(() => {
    if (!baseUrl || !token || !existing) return
    Alert.alert(
      'Delete camera',
      `Delete "${existing.name}"? Its stream stops immediately. Recorded events are kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteCamera(baseUrl, token, existing.id)
                navigation.goBack()
              } catch (err) {
                Alert.alert('Could not delete', err instanceof Error ? err.message : 'Request failed')
              }
            })()
          },
        },
      ],
    )
  }, [baseUrl, token, existing, navigation])

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FormField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Front door"
          error={errors.name}
          autoFocus={!isEdit}
        />
        <FormField
          label="Location"
          value={location}
          onChangeText={setLocation}
          placeholder="Entrance"
        />
        <FormField
          label="Stream URL"
          value={rtspUrl}
          onChangeText={handleRtspChange}
          placeholder="rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101"
          error={errors.rtspUrl}
          autoCapitalize="none"
          keyboardType="url"
          multiline
        />
        <FormField
          label="Snapshot URL"
          value={snapshotUrl}
          onChangeText={handleSnapshotChange}
          placeholder="http://192.168.1.50/ISAPI/Streaming/channels/101/picture"
          hint="HTTP snapshot endpoint, auto-filled from the stream URL. Used for still previews; edit if your camera differs."
          autoCapitalize="none"
          keyboardType="url"
          multiline
        />

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.switchTitle}>Auto reconnect</Text>
            <Text style={styles.switchHint}>Start streaming as soon as the server boots</Text>
          </View>
          <Switch
            value={autoReconnect}
            onValueChange={setAutoReconnect}
            trackColor={{ true: tokens.colors.primary, false: tokens.colors.surface2 }}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.switchTitle}>Face recognition</Text>
            <Text style={styles.switchHint}>Detect and identify faces on this camera</Text>
          </View>
          <Switch
            value={faceEnabled}
            onValueChange={setFaceEnabled}
            trackColor={{ true: tokens.colors.primary, false: tokens.colors.surface2 }}
          />
        </View>

        <Pressable
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={() => { void handleSave() }}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={tokens.colors.text} />
          ) : (
            <Text style={styles.saveText}>{isEdit ? 'Save changes' : 'Add camera'}</Text>
          )}
        </Pressable>

        {isEdit && (
          <Pressable style={styles.deleteBtn} onPress={handleDelete}>
            <Text style={styles.deleteText}>Delete camera</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: tokens.colors.border,
  },
  switchLabel: {
    flex: 1,
    paddingRight: 12,
  },
  switchTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.colors.text,
  },
  switchHint: {
    fontSize: 12,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  saveBtn: {
    backgroundColor: tokens.colors.primary,
    borderRadius: tokens.radii.md,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveText: {
    color: tokens.colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  deleteBtn: {
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  deleteText: {
    color: tokens.colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
})
