import React, { useCallback } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated'

import type { Camera, StreamStatus } from '../api/client'
import tokens from '../theme/tokens'
import CameraSnapshot from './CameraSnapshot'
import PulsingBadge from './PulsingBadge'

type Props = {
  camera: Camera
  streamStatus: StreamStatus | undefined
  onPress: () => void
}

export default function CameraPreviewCard({ camera, streamStatus, onPress }: Props): React.JSX.Element {
  const scale = useSharedValue(1)
  const isLive = streamStatus?.status === 'live'

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const handlePressIn = useCallback(() => { scale.value = withSpring(0.98) }, [scale])
  const handlePressOut = useCallback(() => { scale.value = withSpring(1) }, [scale])

  return (
    <Pressable onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View style={[styles.card, animatedStyle]}>
        <View style={styles.preview}>
          <CameraSnapshot url={camera.snapshot_url} />
          <View style={styles.statusOverlay}>
            {isLive ? (
              <PulsingBadge />
            ) : (
              <Text style={styles.offline}>OFFLINE</Text>
            )}
          </View>
        </View>
        <View style={styles.meta}>
          <Text style={styles.name} numberOfLines={1}>{camera.name}</Text>
          {camera.location ? (
            <Text style={styles.location} numberOfLines={1}>{camera.location}</Text>
          ) : null}
        </View>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.colors.surface1,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 12,
  },
  preview: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: tokens.colors.surface2,
  },
  statusOverlay: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
  },
  offline: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.colors.text,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
    letterSpacing: 0.5,
  },
  meta: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.colors.text,
  },
  location: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
})
