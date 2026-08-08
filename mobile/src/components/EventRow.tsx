import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { eventThumbUrl, type SentryEvent } from '../api/client'
import AuthImage from './AuthImage'
import tokens from '../theme/tokens'

type Props = {
  event: SentryEvent
  cameraName: string
  baseUrl: string
  onPress?: () => void
}

/** Formats a sighting's wall-clock time; the section header carries the date. */
function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(startedAt: number, endedAt: number): string | null {
  const secs = Math.round(endedAt - startedAt)
  if (!Number.isFinite(secs) || secs <= 0) return null
  if (secs < 60) return `${String(secs)}s`
  return `${String(Math.floor(secs / 60))}m ${String(secs % 60)}s`
}

export default function EventRow({ event, cameraName, baseUrl, onPress }: Props): React.JSX.Element {
  const isUnknown = !event.person_id && !event.labeled_person_id
  const title = isUnknown ? 'Unknown person' : event.person_name || 'Known person'
  const duration = formatDuration(event.started_at, event.ended_at)

  return (
    <Pressable style={styles.row} onPress={onPress} disabled={!onPress}>
      <View style={styles.thumbWrap}>
        {event.has_thumb ? (
          <AuthImage
            url={eventThumbUrl(baseUrl, event.id)}
            fallbackIcon="person-outline"
            style={styles.thumb}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Ionicons name="person-outline" size={20} color={tokens.colors.textMuted} />
          </View>
        )}
        {isUnknown && <View style={styles.unknownDot} />}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, isUnknown && styles.titleUnknown]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {cameraName} · {formatTime(event.started_at)}
          {duration ? ` · ${duration}` : ''}
        </Text>
      </View>

      {event.has_clip && (
        <Ionicons name="videocam" size={16} color={tokens.colors.textMuted} style={styles.clipIcon} />
      )}
      {onPress && (
        <Ionicons name="chevron-forward" size={16} color={tokens.colors.textMuted} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  thumbWrap: {
    marginRight: 12,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: tokens.radii.sm,
  },
  thumbEmpty: {
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unknownDot: {
    position: 'absolute',
    right: -2,
    top: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: tokens.colors.warning,
    borderWidth: 2,
    borderColor: tokens.colors.bg,
  },
  body: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.colors.text,
  },
  titleUnknown: {
    color: tokens.colors.warning,
  },
  meta: {
    fontSize: 12,
    color: tokens.colors.textMuted,
    marginTop: 3,
  },
  clipIcon: {
    marginRight: 8,
  },
})
