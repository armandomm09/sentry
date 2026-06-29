import React, { useState } from 'react'
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { useCameraStream } from '../hooks/useCameraStream'
import tokens from '../theme/tokens'
import DetectionOverlay from './DetectionOverlay'
import type { RawDetection } from '../hooks/useDetections'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
type Props = {
  cameraId: string
  cameraName: string
  showDetections?: boolean
  liveBboxes?: RawDetection[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LiveStreamView({
  cameraId,
  cameraName,
  showDetections = false,
  liveBboxes = [],
}: Props): React.JSX.Element {
  const { frameUri, connected, error } = useCameraStream(cameraId)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const handleLayout = (e: LayoutChangeEvent) => {
    setContainerSize({
      width: e.nativeEvent.layout.width,
      height: e.nativeEvent.layout.height,
    })
  }

  return (
    <View style={styles.container} onLayout={handleLayout}>
      {/* Loading state */}
      {frameUri === null && error === null && (
        <View style={styles.centered}>
          <ActivityIndicator color="#ffffff" size="large" />
        </View>
      )}

      {/* Error state */}
      {error !== null && (
        <View style={styles.centered}>
          <Ionicons name="wifi-outline" size={40} color={tokens.colors.textMuted} />
          <Text style={styles.errorText}>Connection lost</Text>
        </View>
      )}

      {/* Live frame */}
      {frameUri !== null && (
        <Image
          key={cameraId}
          source={{ uri: frameUri }}
          style={styles.image}
          resizeMode="cover"
        />
      )}

      {/* Detection overlay */}
      {showDetections && containerSize.width > 0 && (
        <DetectionOverlay
          detections={liveBboxes}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
      )}

      {/* Status pill */}
      <View style={styles.overlay}>
        <View style={styles.pill}>
          <View
            style={[
              styles.dot,
              { backgroundColor: connected ? tokens.colors.online : tokens.colors.danger },
            ]}
          />
          <Text style={styles.cameraName}>{cameraName}</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
  },
  centered: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: tokens.colors.textMuted,
    fontSize: tokens.fontSize.sm,
    marginTop: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pill: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cameraName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
})
