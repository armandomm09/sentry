import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'

import tokens from '../theme/tokens'

export default function PulsingBadge(): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  useEffect(() => {
    if (reducedMotion) return

    scale.value = withRepeat(
      withSequence(
        withTiming(1.6, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
      false,
    )

    opacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
      false,
    )
  }, [reducedMotion, scale, opacity])

  const animatedDotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  return (
    <View style={styles.row}>
      <Animated.View style={[styles.dot, animatedDotStyle]} />
      <Text style={styles.liveText}>LIVE</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.colors.online,
  },
  liveText: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.colors.online,
    marginLeft: 4,
  },
})
