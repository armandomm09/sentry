import React, { useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import tokens from '../theme/tokens'

type Props = {
  /** HTTP(S) snapshot URL returning a single JPEG. */
  url?: string
  /** Refresh interval in ms. */
  intervalMs?: number
  style?: object
}

/**
 * Periodically-refreshed still image from a camera snapshot endpoint. The URL
 * returns one JPEG, so we cache-bust with `?t=<tick>` and bump the tick on an
 * interval. On error (or when no URL is set) a neutral placeholder is shown.
 */
export default function CameraSnapshot({ url, intervalMs = 5000, style }: Props): React.JSX.Element {
  const [tick, setTick] = useState(() => Date.now())
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    setErrored(false)
    setTick(Date.now())
  }, [url])

  useEffect(() => {
    if (!url) return
    const id = setInterval(() => { setTick(Date.now()) }, intervalMs)
    return () => { clearInterval(id) }
  }, [url, intervalMs])

  if (!url || errored) {
    return (
      <View style={[styles.placeholder, style]}>
        <Ionicons name="videocam-off-outline" size={28} color={tokens.colors.textMuted} />
      </View>
    )
  }

  const sep = url.includes('?') ? '&' : '?'
  return (
    <Image
      source={{ uri: `${url}${sep}t=${tick}` }}
      style={[styles.image, style]}
      resizeMode="cover"
      onError={() => { setErrored(true) }}
    />
  )
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    height: '100%',
    backgroundColor: tokens.colors.surface2,
  },
  placeholder: {
    width: '100%',
    height: '100%',
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
