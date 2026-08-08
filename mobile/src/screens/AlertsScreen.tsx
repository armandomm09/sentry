import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useFocusEffect, useIsFocused } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'

import { getCameras, getEvents, type Camera, type SentryEvent } from '../api/client'
import { useAuth } from '../context/AuthContext'
import EventRow from '../components/EventRow'
import tokens from '../theme/tokens'

// ---------------------------------------------------------------------------
// Module-level ref for tab navigator badge wiring
// ---------------------------------------------------------------------------
export const alertsUnreadCountRef: {
  current: number
  onChange: ((n: number) => void) | null
} = { current: 0, onChange: null }

const PAGE_SIZE = 50

type Filter = 'all' | 'unknown'

type Section = {
  title: string
  data: SentryEvent[]
}

// ---------------------------------------------------------------------------
// Grouping — sightings bucketed by local calendar day
// ---------------------------------------------------------------------------
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dayLabel(epochSeconds: number): string {
  const ts = epochSeconds * 1000
  const today = startOfDay(new Date())
  const yesterday = today - 86400000

  if (ts >= today) return 'Today'
  if (ts >= yesterday) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function buildSections(events: SentryEvent[]): Section[] {
  const sections: Section[] = []
  for (const e of events) {
    const label = dayLabel(e.started_at)
    const last = sections[sections.length - 1]
    // The API returns newest-first, so same-day events arrive consecutively.
    if (last && last.title === label) last.data.push(e)
    else sections.push({ title: label, data: [e] })
  }
  return sections
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------
function FilterBar({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }): React.JSX.Element {
  return (
    <View style={styles.filterBar}>
      {(['all', 'unknown'] as const).map((f) => {
        const active = value === f
        return (
          <Pressable
            key={f}
            onPress={() => { onChange(f) }}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {f === 'all' ? 'All' : 'Unknown only'}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function AlertsScreen(): React.JSX.Element {
  const { baseUrl, token } = useAuth()
  const isFocused = useIsFocused()

  const [cameras, setCameras] = useState<Camera[]>([])
  const [events, setEvents] = useState<SentryEvent[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cameraNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of cameras) map[c.id] = c.name
    return map
  }, [cameras])

  useEffect(() => {
    if (!baseUrl || !token) return
    getCameras(baseUrl, token).then(setCameras).catch(() => undefined)
  }, [baseUrl, token])

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  const loadFirstPage = useCallback(async (isRefresh = false): Promise<void> => {
    if (!baseUrl || !token) return
    if (isRefresh) setRefreshing(true)
    try {
      const page = await getEvents(baseUrl, token, {
        limit: PAGE_SIZE,
        unknownOnly: filter === 'unknown',
      })
      setEvents(page.events)
      setNextBefore(page.next_before)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [baseUrl, token, filter])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token || loadingMore || nextBefore === null) return
    setLoadingMore(true)
    try {
      const page = await getEvents(baseUrl, token, {
        limit: PAGE_SIZE,
        before: nextBefore,
        unknownOnly: filter === 'unknown',
      })
      // Guard against duplicates if a sighting lands exactly on the cursor.
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        return [...prev, ...page.events.filter((e) => !seen.has(e.id))]
      })
      setNextBefore(page.next_before)
    } catch {
      // Keep what is already listed; pull-to-refresh retries.
    } finally {
      setLoadingMore(false)
    }
  }, [baseUrl, token, loadingMore, nextBefore, filter])

  // Reload whenever the filter changes.
  useEffect(() => {
    setLoading(true)
    void loadFirstPage()
  }, [loadFirstPage])

  // New sightings arrive as push notifications while the app is backgrounded,
  // so refresh on focus rather than holding a socket open on this screen.
  useFocusEffect(
    useCallback(() => {
      void loadFirstPage(true)
    }, [loadFirstPage]),
  )

  // ---------------------------------------------------------------------------
  // Unread badge — counts sightings that arrived while the tab was unfocused
  // ---------------------------------------------------------------------------
  const lastSeenTop = useRef<string | null>(null)

  useEffect(() => {
    if (isFocused) {
      lastSeenTop.current = events[0]?.id ?? null
      alertsUnreadCountRef.current = 0
      alertsUnreadCountRef.onChange?.(0)
      return
    }
    const idx = events.findIndex((e) => e.id === lastSeenTop.current)
    const unread = idx === -1 ? 0 : idx
    alertsUnreadCountRef.current = unread
    alertsUnreadCountRef.onChange?.(unread)
  }, [isFocused, events])

  const sections = useMemo(() => buildSections(events), [events])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const renderItem = useCallback(({ item }: { item: SentryEvent }) => (
    <EventRow
      event={item}
      cameraName={cameraNames[item.camera_id] ?? 'Unknown camera'}
      baseUrl={baseUrl ?? ''}
    />
  ), [cameraNames, baseUrl])

  if (loading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={tokens.colors.primary} />
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <FilterBar value={filter} onChange={setFilter} />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title.toUpperCase()}</Text>
        )}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        refreshing={refreshing}
        onRefresh={() => { void loadFirstPage(true) }}
        onEndReached={() => { void loadMore() }}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={styles.footerSpinner} color={tokens.colors.textMuted} />
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons
              name={error ? 'cloud-offline-outline' : 'notifications-off-outline'}
              size={48}
              color={tokens.colors.textMuted}
            />
            <Text style={styles.emptyTitle}>{error ?? 'No alerts yet'}</Text>
            <Text style={styles.emptySubtitle}>
              {error
                ? 'Pull down to try again'
                : filter === 'unknown'
                  ? 'No unrecognized faces have been seen'
                  : 'Sightings from your cameras will appear here'}
            </Text>
          </View>
        }
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
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: tokens.radii.full,
    backgroundColor: tokens.colors.surface2,
  },
  chipActive: {
    backgroundColor: tokens.colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.colors.textMuted,
  },
  chipTextActive: {
    color: tokens.colors.text,
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.colors.textMuted,
    paddingHorizontal: 16,
    paddingVertical: 8,
    letterSpacing: 0.5,
  },
  footerSpinner: {
    marginVertical: 16,
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
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 8,
    textAlign: 'center',
  },
})
