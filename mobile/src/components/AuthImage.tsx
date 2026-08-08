import React, { useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'

type Props = {
  /** Absolute URL of an API image route (thumbs, person photos). */
  url: string
  /** Icon shown when the image is missing or fails to load. */
  fallbackIcon?: keyof typeof Ionicons.glyphMap
  style?: object
}

/**
 * Image served from an authenticated API route.
 *
 * These endpoints reject unauthenticated requests, so the bearer token rides
 * along in the request headers rather than the URL — React Native's image
 * loader supports per-source headers, unlike a plain <img>.
 */
export default function AuthImage({ url, fallbackIcon = 'image-outline', style }: Props): React.JSX.Element {
  const { token } = useAuth()
  const [errored, setErrored] = useState(false)

  if (!token || errored) {
    return (
      <View style={[styles.fallback, style]}>
        <Ionicons name={fallbackIcon} size={20} color={tokens.colors.textMuted} />
      </View>
    )
  }

  return (
    <Image
      source={{ uri: url, headers: { Authorization: `Bearer ${token}` } }}
      style={[styles.image, style]}
      resizeMode="cover"
      onError={() => { setErrored(true) }}
    />
  )
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: tokens.colors.surface2,
  },
  fallback: {
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
