import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'

import { getCameras, type Camera } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useDetections, type Detection } from '../hooks/useDetections'
import DetectionCard from '../components/DetectionCard'
import tokens from '../theme/tokens'

// ---------------------------------------------------------------------------
// Module-level ref for tab navigator badge wiring (Task 11)
// ---------------------------------------------------------------------------
export const alertsUnreadCountRef: {
  current: number
  onChange: ((n: number) => void) | null
} = { current: 0, onChange: null }

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------
type Section = {
  title: string
  data: Detection[]
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function buildSections(detections: Detection[]): Section[] {
  const now = new Date()
  const todayStart = startOfDay(now).getTime()
  const yesterdayStart = todayStart - 86400000

  const justNow: Detection[] = []
  const today: Detection[] = []
  const yesterday: Detection[] = []

  for (const d of detections) {
    const ts = new Date(d.ts).getTime()
    const age = now.getTime() - ts
    if (age < FIVE_MINUTES_MS) {
      justNow.push(d)
    } else if (ts >= todayStart) {
      today.push(d)
    } else if (ts >= yesterdayStart) {
      yesterday.push(d)
    }
    // older than yesterday — dropped by the 100-cap already
  }

  const sections: Section[] = []
  if (justNow.length > 0) sections.push({ title: 'Just Now', data: justNow })
  if (today.length > 0) sections.push({ title: 'Today', data: today })
  if (yesterday.length > 0) sections.push({ title: 'Yesterday', data: yesterday })
  return sections
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function AlertsScreen(): React.JSX.Element {
  const { baseUrl, token } = useAuth()
  const isFocused = useIsFocused()

  // Camera fetch
  const [cameras, setCameras] = useState<Camera[]>([])
  useEffect(() => {
    if (!baseUrl || !token) return
    getCameras(baseUrl, token)
      .then(setCameras)
      .catch(() => undefined)
  }, [baseUrl, token])

  const cameraIds = useMemo(() => cameras.map((c) => c.id), [cameras])

  // Detections across all cameras
  const { detections } = useDetections(cameraIds, cameras)

  // Grouped sections
  const sections = useMemo(() => buildSections(detections), [detections])

  // ---------------------------------------------------------------------------
  // Unread badge logic
  // ---------------------------------------------------------------------------
  const lastSeenCount = useRef<number>(0)

  useEffect(() => {
    if (isFocused) {
      // User is viewing the screen — reset badge
      alertsUnreadCountRef.current = 0
      alertsUnreadCountRef.onChange?.(0)
      lastSeenCount.current = detections.length
    } else {
      // Screen is not visible — compute unread delta
      const unread = Math.max(0, detections.length - lastSeenCount.current)
      alertsUnreadCountRef.current = unread
      alertsUnreadCountRef.onChange?.(unread)
    }
  }, [isFocused, detections.length])

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => (
      <Text style={styles.sectionHeader}>{section.title.toUpperCase()}</Text>
    ),
    [],
  )

  const renderItem = useCallback(
    ({ item }: { item: Detection }) => <DetectionCard detection={item} />,
    [],
  )

  const keyExtractor = useCallback((item: Detection) => item.id, [])

  const ListEmptyComponent = (
    <View style={styles.emptyContainer}>
      <Ionicons
        name="notifications-off-outline"
        size={48}
        color={tokens.colors.textMuted}
      />
      <Text style={styles.emptyTitle}>No alerts yet</Text>
      <Text style={styles.emptySubtitle}>
        Detections will appear here in real time
      </Text>
    </View>
  )

  return (
    <View style={styles.root}>
      <SectionList
        sections={sections}
        keyExtractor={keyExtractor}
        renderSectionHeader={renderSectionHeader}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={ListEmptyComponent}
        stickySectionHeadersEnabled={false}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  listContent: {
    flexGrow: 1,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.colors.textMuted,
    paddingHorizontal: 16,
    paddingVertical: 8,
    letterSpacing: 0.5,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: tokens.colors.text,
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 8,
    textAlign: 'center',
  },
})
