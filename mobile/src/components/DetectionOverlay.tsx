import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RawDetection } from '../hooks/useDetections'

type Props = {
  detections: RawDetection[]
  containerWidth: number
  containerHeight: number
}

const KNOWN_COLOR = '#38d977'
const UNKNOWN_COLOR = '#e83a29'

export default function DetectionOverlay({
  detections,
  containerWidth,
  containerHeight,
}: Props): React.JSX.Element | null {
  if (!detections.length) return null

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {detections.map((det, i) => {
        const [x1, y1, x2, y2] = det.bbox
        const left = x1 * containerWidth
        const top = y1 * containerHeight
        const width = (x2 - x1) * containerWidth
        const height = (y2 - y1) * containerHeight

        const isKnown = det.person_id !== null
        const color = isKnown ? KNOWN_COLOR : UNKNOWN_COLOR
        const label = isKnown ? (det.name ?? 'Known') : 'Unknown'
        const pct = isKnown
          ? det.similarity != null
            ? `${Math.round(det.similarity * 100)}%`
            : ''
          : `${Math.round(det.score * 100)}%`

        return (
          <View
            key={i}
            style={[styles.box, { left, top, width, height, borderColor: color }]}
          >
            <View style={[styles.labelBg, { backgroundColor: color }]}>
              <Text style={styles.labelText}>
                {label}
                {pct ? `  ${pct}` : ''}
              </Text>
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: 2,
  },
  labelBg: {
    position: 'absolute',
    top: -20,
    left: -1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 2,
  },
  labelText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '700',
  },
})
