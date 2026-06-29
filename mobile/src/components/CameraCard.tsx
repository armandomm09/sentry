import React, { useCallback } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'

import type { Camera, StreamStatus } from '../api/client'
import tokens from '../theme/tokens'
import PulsingBadge from './PulsingBadge'

type Props = {
  camera: Camera
  streamStatus: StreamStatus | undefined
  onPress: () => void
}

export default function CameraCard({ camera, streamStatus, onPress }: Props): React.JSX.Element {
  const scale = useSharedValue(1)
  const isLive = streamStatus?.status === 'live'

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1)
  }, [scale])

  return (
    <Pressable onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View style={[styles.card, animatedStyle]}>
        <View style={styles.row}>
          <Ionicons
            name="videocam"
            size={32}
            color={isLive ? tokens.colors.primary : tokens.colors.textMuted}
          />
          <View style={styles.info}>
            <Text style={styles.name}>{camera.name}</Text>
            <Text style={styles.location}>{camera.location}</Text>
            <View style={styles.statusRow}>
              {isLive ? (
                <PulsingBadge />
              ) : (
                <Text style={styles.offline}>OFFLINE</Text>
              )}
            </View>
          </View>
        </View>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.colors.surface1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.colors.text,
  },
  location: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  statusRow: {
    marginTop: 8,
  },
  offline: {
    fontSize: 11,
    color: tokens.colors.textMuted,
  },
})
