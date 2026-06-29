import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { getPersons, Person } from '../api/client'
import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'

// ---------------------------------------------------------------------------
// Skeleton row
// ---------------------------------------------------------------------------
function SkeletonRow(): React.JSX.Element {
  const opacity = useSharedValue(1)

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
      false,
    )
  }, [opacity])

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View style={[styles.skeletonRow, animStyle]} />
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === '') return '?'
  const first = parts[0][0] ?? ''
  const second = parts.length > 1 ? (parts[1][0] ?? '') : ''
  return (first + second).toUpperCase()
}

// ---------------------------------------------------------------------------
// Person row
// ---------------------------------------------------------------------------
interface PersonRowProps {
  person: Person
  isLast: boolean
}

function PersonRow({ person, isLast }: PersonRowProps): React.JSX.Element {
  function handlePress(): void {
    Alert.alert('', 'Manage persons on the web dashboard')
  }

  return (
    <>
      <TouchableOpacity style={styles.row} onPress={handlePress} activeOpacity={0.7}>
        <View style={styles.avatar}>
          <Text style={styles.initials}>{getInitials(person.name)}</Text>
        </View>
        <View style={styles.rowContent}>
          <Text style={styles.name}>{person.name}</Text>
          <Text style={styles.photoCount}>
            {person.photo_count} {person.photo_count === 1 ? 'photo' : 'photos'} enrolled
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={tokens.colors.textMuted} />
      </TouchableOpacity>
      {!isLast && <View style={styles.separator} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
interface EmptyStateProps {
  hasQuery: boolean
}

function EmptyState({ hasQuery }: EmptyStateProps): React.JSX.Element {
  return (
    <View style={styles.emptyContainer}>
      <Ionicons name="people-outline" size={48} color={tokens.colors.textMuted} />
      <Text style={styles.emptyTitle}>No persons enrolled</Text>
      {!hasQuery && (
        <Text style={styles.emptySubtitle}>Enroll persons from the web dashboard</Text>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function PersonsScreen(): React.JSX.Element {
  const { baseUrl, token } = useAuth()

  const [persons, setPersons] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')

  const fetchPersons = useCallback(
    async (isRefresh = false): Promise<void> => {
      if (!baseUrl || !token) return

      if (isRefresh) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }

      try {
        const data = await getPersons(baseUrl, token)
        setPersons(data)
      } catch {
        // silently ignore fetch errors — list remains empty
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [baseUrl, token],
  )

  useEffect(() => {
    void fetchPersons()
  }, [fetchPersons])

  const filtered = persons.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <View style={styles.screen}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={18} color={tokens.colors.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search persons"
          placeholderTextColor={tokens.colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {loading ? (
        <View style={styles.skeletonContainer}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          refreshing={refreshing}
          onRefresh={() => void fetchPersons(true)}
          renderItem={({ item, index }) => (
            <PersonRow
              person={item}
              isLast={index === filtered.length - 1}
            />
          )}
          ListEmptyComponent={<EmptyState hasQuery={query.length > 0} />}
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokens.colors.surface2,
    borderRadius: 12,
    height: 44,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    marginTop: 8,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: tokens.colors.text,
    fontSize: 15,
  },
  skeletonContainer: {
    paddingHorizontal: 16,
    gap: 10,
    marginTop: 4,
  },
  skeletonRow: {
    height: 68,
    borderRadius: 12,
    backgroundColor: tokens.colors.surface2,
  },
  listContent: {
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: tokens.colors.surface2,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  initials: {
    color: tokens.colors.primary,
    fontSize: 20,
    fontWeight: '700',
  },
  rowContent: {
    flex: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: tokens.colors.text,
  },
  photoCount: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: tokens.colors.border,
    marginLeft: 76,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 60,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: tokens.colors.text,
    marginTop: 12,
  },
  emptySubtitle: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 8,
  },
})
