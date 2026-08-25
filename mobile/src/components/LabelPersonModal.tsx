import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { getPersons, labelEvent, type LabelEventResult, type Person } from '../api/client'
import { useAuth } from '../context/AuthContext'
import AuthImage from './AuthImage'
import TextPromptModal from './TextPromptModal'
import tokens from '../theme/tokens'

/** Busy-state key for the create-and-label flow, which has no person id yet. */
const NEW_PERSON_KEY = '__new__'

type Props = {
  visible: boolean
  /** Sighting being named. */
  eventId: string
  /** Authenticated URL of the face crop that will be enrolled. */
  thumbUrl: string
  onCancel: () => void
  /** Called after a successful label with the result and the person's display name. */
  onLabeled: (result: LabelEventResult, personName: string) => void
}

/**
 * Assigns an unrecognized sighting to a person, enrolling its face crop.
 *
 * The crop is shown at the top because enrolling a bad frame quietly poisons
 * future recognition — the user should see the exact photo before committing to
 * it. That preview is the event thumbnail, which is the same file the backend
 * uploads to the face-service, so it can't drift from what actually gets added.
 */
export default function LabelPersonModal({
  visible,
  eventId,
  thumbUrl,
  onCancel,
  onLabeled,
}: Props): React.JSX.Element {
  const { baseUrl, token } = useAuth()

  const [persons, setPersons] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [namingNew, setNamingNew] = useState(false)

  // Reload the roster each time the sheet opens — people may have been added
  // from the Persons tab since this screen was first mounted.
  useEffect(() => {
    if (!visible || !baseUrl || !token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getPersons(baseUrl, token)
      .then((list) => {
        if (!cancelled) setPersons(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load people')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible, baseUrl, token])

  const submit = useCallback(
    async (
      target: { personId: string } | { newPersonName: string },
      displayName: string,
      busyKey: string,
    ): Promise<void> => {
      if (!baseUrl || !token || submittingId) return
      setSubmittingId(busyKey)
      setError(null)
      try {
        const result = await labelEvent(baseUrl, token, eventId, target)
        onLabeled(result, displayName)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to label sighting')
      } finally {
        setSubmittingId(null)
      }
    },
    [baseUrl, token, eventId, submittingId, onLabeled],
  )

  // The prompt stays open while the request is in flight so it can show its own
  // spinner; on failure it closes and the sheet surfaces the error.
  const submitNewPerson = useCallback(
    async (name: string): Promise<void> => {
      await submit({ newPersonName: name }, name, NEW_PERSON_KEY)
      setNamingNew(false)
    },
    [submit],
  )

  const busy = submittingId !== null

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => { if (!busy) onCancel() }}
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <AuthImage url={thumbUrl} fallbackIcon="person-outline" style={styles.preview} />
            <Text style={styles.title}>Who is this?</Text>
            <Text style={styles.subtitle}>
              This photo will be added to their profile and used to recognize them from now on.
            </Text>
          </View>

          {error !== null && <Text style={styles.error}>{error}</Text>}

          {loading ? (
            <ActivityIndicator style={styles.loader} color={tokens.colors.primary} />
          ) : (
            <FlatList
              data={persons}
              keyExtractor={(p) => p.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                <Pressable
                  style={[styles.row, styles.newRow, busy && styles.rowDisabled]}
                  onPress={() => { setNamingNew(true) }}
                  disabled={busy}
                >
                  <View style={styles.newIcon}>
                    <Ionicons name="add" size={20} color={tokens.colors.primary} />
                  </View>
                  <Text style={styles.newText}>New person</Text>
                </Pressable>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, busy && styles.rowDisabled]}
                  onPress={() => {
                    void submit({ personId: item.id }, item.name, item.id)
                  }}
                  disabled={busy}
                >
                  <View style={styles.avatar}>
                    <Ionicons name="person" size={18} color={tokens.colors.textMuted} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowMeta}>
                      {item.photo_count === 1 ? '1 photo' : `${String(item.photo_count)} photos`}
                    </Text>
                  </View>
                  {submittingId === item.id && (
                    <ActivityIndicator color={tokens.colors.textMuted} size="small" />
                  )}
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  No people enrolled yet — add the first one above.
                </Text>
              }
            />
          )}

          <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={busy}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>

      <TextPromptModal
        visible={namingNew}
        title="Name this person"
        placeholder="e.g. Maria"
        confirmLabel="Add"
        submitting={submittingId === NEW_PERSON_KEY}
        onCancel={() => { setNamingNew(false) }}
        onSubmit={(name) => { void submitNewPerson(name) }}
      />
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: tokens.colors.surface1,
    borderTopLeftRadius: tokens.radii.xl,
    borderTopRightRadius: tokens.radii.xl,
    paddingTop: 20,
    paddingHorizontal: 16,
    paddingBottom: 24,
    maxHeight: '85%',
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  preview: {
    width: 112,
    height: 112,
    borderRadius: tokens.radii.lg,
  },
  title: {
    fontSize: tokens.fontSize.lg,
    fontWeight: tokens.fontWeight.bold,
    color: tokens.colors.text,
    marginTop: 14,
  },
  subtitle: {
    fontSize: tokens.fontSize.sm,
    color: tokens.colors.textMuted,
    textAlign: 'center',
    marginTop: 6,
  },
  error: {
    fontSize: tokens.fontSize.sm,
    color: tokens.colors.danger,
    textAlign: 'center',
    marginTop: 12,
  },
  loader: {
    marginVertical: 32,
  },
  list: {
    marginTop: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: tokens.radii.md,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  newRow: {
    backgroundColor: tokens.colors.surface2,
    marginBottom: 8,
  },
  newIcon: {
    width: 36,
    height: 36,
    borderRadius: tokens.radii.full,
    backgroundColor: tokens.colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newText: {
    fontSize: tokens.fontSize.md,
    fontWeight: tokens.fontWeight.semibold,
    color: tokens.colors.primary,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: tokens.radii.full,
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowName: {
    fontSize: tokens.fontSize.md,
    color: tokens.colors.text,
  },
  rowMeta: {
    fontSize: tokens.fontSize.xs,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  empty: {
    fontSize: tokens.fontSize.sm,
    color: tokens.colors.textMuted,
    textAlign: 'center',
    paddingVertical: 24,
  },
  cancelBtn: {
    height: 48,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  cancelText: {
    fontSize: tokens.fontSize.md,
    fontWeight: tokens.fontWeight.semibold,
    color: tokens.colors.text,
  },
})
