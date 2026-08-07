import React, { useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'

type Props = {
  /** Camera whose still image to show. */
  cameraId?: string
  /** Refresh interval in ms. */
  intervalMs?: number
  style?: object
}

/**
 * Periodically-refreshed still image for a camera.
 *
 * The camera's own snapshot URL is on a private network the phone cannot
 * reach, so the image is fetched from the backend's authenticated proxy
 * (`GET /api/cameras/:id/snapshot`) instead. That endpoint returns one JPEG,
 * so we cache-bust with `?t=<tick>` and bump the tick on an interval. On error
 * (or before a session exists) a neutral placeholder is shown.
 */
export default function CameraSnapshot({ cameraId, intervalMs = 5000, style }: Props): React.JSX.Element {
  const { baseUrl, token } = useAuth()
  const [tick, setTick] = useState(() => Date.now())
  const [errored, setErrored] = useState(false)

  const ready = Boolean(cameraId && baseUrl && token)

  useEffect(() => {
    setErrored(false)
    setTick(Date.now())
  }, [cameraId, baseUrl, token])

  useEffect(() => {
    if (!ready) return
    const id = setInterval(() => { setTick(Date.now()) }, intervalMs)
    return () => { clearInterval(id) }
  }, [ready, intervalMs])

  if (!ready || errored) {
    return (
      <View style={[styles.placeholder, style]}>
        <Ionicons name="videocam-off-outline" size={28} color={tokens.colors.textMuted} />
      </View>
    )
  }

  return (
    <Image
      source={{
        uri: `${baseUrl!}/api/cameras/${encodeURIComponent(cameraId!)}/snapshot?t=${tick}`,
        headers: { Authorization: `Bearer ${token!}` },
      }}
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
