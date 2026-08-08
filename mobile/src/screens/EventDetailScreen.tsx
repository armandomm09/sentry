import React, { useLayoutEffect, useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useVideoPlayer, VideoView } from 'expo-video'
import { Ionicons } from '@expo/vector-icons'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { AlertsStackParamList } from '../navigation/types'
import { eventClipUrl, eventThumbUrl } from '../api/client'
import { useAuth } from '../context/AuthContext'
import AuthImage from '../components/AuthImage'
import tokens from '../theme/tokens'

type Props = NativeStackScreenProps<AlertsStackParamList, 'EventDetailScreen'>

function formatRange(startedAt: number, endedAt: number): string {
  const start = new Date(startedAt * 1000)
  const date = start.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const secs = Math.round(endedAt - startedAt)
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

  const isUnknown = !event.person_id && !event.labeled_person_id
  const title = isUnknown ? 'Unknown person' : event.person_name || 'Known person'

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

      <View style={styles.details}>
        <DetailRow label="Person" value={title} />
        <DetailRow label="Camera" value={cameraName} />
        <DetailRow label="When" value={formatRange(event.started_at, event.ended_at)} />
        {!isUnknown && event.similarity > 0 && (
          <DetailRow label="Match" value={`${(event.similarity * 100).toFixed(0)}% similarity`} />
        )}
      </View>
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
