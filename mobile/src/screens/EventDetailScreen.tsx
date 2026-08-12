import React, { useLayoutEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useVideoPlayer, VideoView } from 'expo-video'
import { Ionicons } from '@expo/vector-icons'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { AlertsStackParamList } from '../navigation/types'
import { eventClipUrl, eventThumbUrl } from '../api/client'
import { useAuth } from '../context/AuthContext'
import AuthImage from '../components/AuthImage'
import LabelPersonModal from '../components/LabelPersonModal'
import tokens from '../theme/tokens'

type Props = NativeStackScreenProps<AlertsStackParamList, 'EventDetailScreen'>

/** Both timestamps are epoch milliseconds — the recorder stores `toMs(ts)`. */
function formatRange(startedAt: number, endedAt: number): string {
  const start = new Date(startedAt)
  const date = start.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const secs = Math.round((endedAt - startedAt) / 1000)
  if (!Number.isFinite(secs) || secs <= 0) return `${date} at ${time}`
  const dur = secs < 60 ? `${String(secs)}s` : `${String(Math.floor(secs / 60))}m ${String(secs % 60)}s`
  return `${date} at ${time} · seen for ${dur}`
}

/** One row of the sighting's metadata table. */
function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  )
}

export default function EventDetailScreen({ route, navigation }: Props): React.JSX.Element {
  const { event, cameraName } = route.params
  const { baseUrl, token } = useAuth()

  // Set once this sighting is named here. The Alerts list reloads on focus, so
  // this only has to keep *this* screen honest until the user backs out.
  const [labeled, setLabeled] = useState<{ name: string; retro: number } | null>(null)
  const [picking, setPicking] = useState(false)

  const wasUnknown = !event.person_id && !event.labeled_person_id
  const isUnknown = wasUnknown && labeled === null
  const title = labeled
    ? labeled.name
    : isUnknown
      ? 'Unknown person'
      : event.person_name || 'Known person'

  useLayoutEffect(() => {
    navigation.setOptions({ title })
  }, [navigation, title])

  // The clip endpoint is authenticated, so the bearer token rides along as a
  // request header — expo-video forwards these on iOS and Android.
  const source = useMemo(() => {
    if (!event.has_clip || !baseUrl || !token) return null
    return {
      uri: eventClipUrl(baseUrl, event.id),
      headers: { Authorization: `Bearer ${token}` },
    }
  }, [event.has_clip, event.id, baseUrl, token])

  const player = useVideoPlayer(source, (p) => {
    p.loop = false
  })

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {source ? (
        <VideoView
          style={styles.video}
          player={player}
          nativeControls
          contentFit="contain"
        />
      ) : (
        <View style={styles.noClip}>
          {event.has_thumb ? (
            <AuthImage
              url={eventThumbUrl(baseUrl ?? '', event.id)}
              fallbackIcon="person-outline"
              style={styles.thumb}
            />
          ) : (
            <Ionicons name="person-outline" size={40} color={tokens.colors.textMuted} />
          )}
          <Text style={styles.noClipText}>
            {event.clip_expired
              ? 'The clip for this sighting has expired'
              : 'No clip was recorded for this sighting'}
          </Text>
        </View>
      )}

      {wasUnknown && (
        <View style={styles.labelCard}>
          {labeled ? (
            <>
              <Ionicons name="checkmark-circle" size={22} color={tokens.colors.online} />
              <View style={styles.labelCardText}>
                <Text style={styles.labelCardTitle}>Enrolled as {labeled.name}</Text>
                <Text style={styles.labelCardBody}>
                  {labeled.retro > 0
                    ? `This face is now recognized, and ${String(labeled.retro)} earlier ${labeled.retro === 1 ? 'sighting was' : 'sightings were'} matched to them too.`
                    : 'This face will be recognized from now on.'}
                </Text>
              </View>
            </>
          ) : event.has_thumb ? (
            <>
              <AuthImage
                url={eventThumbUrl(baseUrl ?? '', event.id)}
                fallbackIcon="person-outline"
                style={styles.labelCardThumb}
              />
              <View style={styles.labelCardText}>
                <Text style={styles.labelCardTitle}>Not recognized</Text>
                <Text style={styles.labelCardBody}>
                  Name this person to teach the cameras who they are.
                </Text>
                <Pressable style={styles.labelBtn} onPress={() => { setPicking(true) }}>
                  <Ionicons name="person-add-outline" size={16} color={tokens.colors.text} />
                  <Text style={styles.labelBtnText}>Who is this?</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Ionicons name="alert-circle-outline" size={22} color={tokens.colors.textMuted} />
              <View style={styles.labelCardText}>
                <Text style={styles.labelCardTitle}>Not recognized</Text>
                <Text style={styles.labelCardBody}>
                  No usable face was captured for this sighting, so it can&apos;t be enrolled.
                </Text>
              </View>
            </>
          )}
        </View>
      )}

      <View style={styles.details}>
        <DetailRow label="Person" value={title} />
        <DetailRow label="Camera" value={cameraName} />
        <DetailRow label="When" value={formatRange(event.started_at, event.ended_at)} />
        {!isUnknown && !labeled && event.similarity > 0 && (
          <DetailRow label="Match" value={`${(event.similarity * 100).toFixed(0)}% similarity`} />
        )}
      </View>

      <LabelPersonModal
        visible={picking}
        eventId={event.id}
        thumbUrl={eventThumbUrl(baseUrl ?? '', event.id)}
        onCancel={() => { setPicking(false) }}
        onLabeled={(result, personName) => {
          setPicking(false)
          setLabeled({ name: personName, retro: result.retro_labeled })
        }}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  content: {
    paddingBottom: 32,
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
  },
  noClip: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: tokens.colors.surface1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  thumb: {
    width: 96,
    height: 96,
    borderRadius: tokens.radii.md,
  },
  noClipText: {
    color: tokens.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  labelCard: {
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 16,
    padding: 14,
    borderRadius: tokens.radii.lg,
    backgroundColor: tokens.colors.surface1,
  },
  labelCardThumb: {
    width: 64,
    height: 64,
    borderRadius: tokens.radii.md,
  },
  labelCardText: {
    flex: 1,
  },
  labelCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.colors.text,
  },
  labelCardBody: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 4,
  },
  labelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.primary,
  },
  labelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.colors.text,
  },
  details: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  detailRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: tokens.colors.border,
  },
  detailLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.colors.textMuted,
    letterSpacing: 0.6,
  },
  detailValue: {
    fontSize: 15,
    color: tokens.colors.text,
    marginTop: 4,
  },
})
