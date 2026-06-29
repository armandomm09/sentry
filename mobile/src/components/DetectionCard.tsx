import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'

import type { Detection } from '../hooks/useDetections'
import tokens from '../theme/tokens'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTimeAgo(ts: string): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
type Props = {
  detection: Detection
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function DetectionCard({ detection }: Props): React.JSX.Element {
  const translateX = useSharedValue(60)
  const opacity = useSharedValue(0)

  useEffect(() => {
    translateX.value = withTiming(0, { duration: 250 })
    opacity.value = withTiming(1, { duration: 250 })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: opacity.value,
  }))

  const isKnown = detection.personId !== null

  return (
    <Animated.View style={[styles.card, animatedStyle]}>
      {/* Icon */}
      <Ionicons
        name={isKnown ? 'person-circle' : 'help-circle'}
        size={36}
        color={isKnown ? tokens.colors.primary : tokens.colors.warning}
      />

      {/* Content */}
      <View style={styles.content}>
        <Text
          style={[
            styles.name,
            { color: isKnown ? tokens.colors.text : tokens.colors.warning },
          ]}
        >
          {isKnown ? detection.name : 'Unknown'}
        </Text>
        <Text style={styles.meta}>{detection.cameraName}</Text>
        <Text style={styles.meta}>
          Confidence: {Math.round(detection.score * 100)}%
        </Text>
      </View>

      {/* Time */}
      <Text style={styles.time}>{formatTimeAgo(detection.ts)}</Text>
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.colors.surface1,
    borderRadius: 12,
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    marginLeft: 10,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
  },
  meta: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  time: {
    fontSize: 13,
    color: tokens.colors.textMuted,
  },
})
