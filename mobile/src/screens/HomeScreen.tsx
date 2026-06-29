import React, { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { HomeStackParamList } from '../navigation/types'
import type { Camera, StreamMap } from '../api/client'
import { getCameras, getStreams } from '../api/client'
import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'
import CameraCard from '../components/CameraCard'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Props = NativeStackScreenProps<HomeStackParamList, 'HomeScreen'>

// ---------------------------------------------------------------------------
// Skeleton placeholder
// ---------------------------------------------------------------------------
function SkeletonCard(): React.JSX.Element {
  const opacity = useSharedValue(0.4)

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 600 }),
        withTiming(0.4, { duration: 600 }),
      ),
      -1,
      false,
    )
  }, [opacity])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  return <Animated.View style={[styles.skeleton, animatedStyle]} />
}

// ---------------------------------------------------------------------------
// HomeScreen
// ---------------------------------------------------------------------------
export default function HomeScreen({ navigation }: Props): React.JSX.Element {
  const { baseUrl, token } = useAuth()

  const [cameras, setCameras] = useState<Camera[]>([])
  const [streams, setStreams] = useState<StreamMap>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token) return
    try {
      const [cams, strs] = await Promise.all([
        getCameras(baseUrl, token),
        getStreams(baseUrl, token),
      ])
      setCameras(cams)
      setStreams(strs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cameras')
    }
  }, [baseUrl, token])

  useEffect(() => {
    void fetchData().finally(() => { setLoading(false) })
  }, [fetchData])

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await fetchData()
    setRefreshing(false)
  }, [fetchData])

  const handleCameraPress = useCallback(
    (camera: Camera) => {
      navigation.navigate('CameraDetailScreen', {
        cameraId: camera.id,
        cameraName: camera.name,
      })
    },
    [navigation],
  )

  const renderItem = useCallback(
    ({ item }: { item: Camera }) => (
      <CameraCard
        camera={item}
        streamStatus={streams[item.id]}
        onPress={() => { handleCameraPress(item) }}
      />
    ),
    [streams, handleCameraPress],
  )

  const keyExtractor = useCallback((item: Camera) => item.id, [])

  const ListHeader = (
    <View>
      <Text style={styles.title}>Sentry</Text>
      <Text style={styles.subtitle}>{cameras.length} camera</Text>
    </View>
  )

  // Loading state — skeleton cards
  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Sentry</Text>
        <View style={styles.skeletonContainer}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </View>
    )
  }

  // Error state
  if (error !== null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={() => { void fetchData() }}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  // Main list
  return (
    <View style={styles.container}>
      <FlatList<Camera>
        data={cameras}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={ListHeader}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void handleRefresh() }}
            tintColor={tokens.colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="shield-outline" size={48} color={tokens.colors.textMuted} />
            <Text style={styles.emptyTitle}>No cameras configured</Text>
            <Text style={styles.emptySubtitle}>Check your server connection</Text>
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
  container: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: tokens.colors.text,
    padding: 16,
  },
  subtitle: {
    fontSize: 15,
    color: tokens.colors.textMuted,
    paddingHorizontal: 16,
    marginTop: -8,
    marginBottom: 5
  },
  listContent: {
    paddingHorizontal: 16,
  },
  skeletonContainer: {
    paddingHorizontal: 16,
  },
  skeleton: {
    backgroundColor: tokens.colors.surface2,
    borderRadius: 16,
    height: 88,
    marginBottom: 12,
  },
  errorText: {
    color: tokens.colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
    paddingHorizontal: 32,
  },
  retryButton: {
    backgroundColor: tokens.colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: tokens.radii.sm,
  },
  retryText: {
    color: tokens.colors.text,
    fontWeight: '600',
    fontSize: 15,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyTitle: {
    color: tokens.colors.text,
    fontSize: 17,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    color: tokens.colors.textMuted,
    fontSize: 13,
    marginTop: 8,
  },
})
