import React, { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { HomeStackParamList } from '../navigation/types'
import type { Camera } from '../api/client'
import { getCameras } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useDetections } from '../hooks/useDetections'
import type { Detection } from '../hooks/useDetections'
import tokens from '../theme/tokens'
import LiveStreamView from '../components/LiveStreamView'
import DetectionCard from '../components/DetectionCard'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Props = NativeStackScreenProps<HomeStackParamList, 'CameraDetailScreen'>

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function CameraDetailScreen({ route, navigation }: Props): React.JSX.Element {
  const { cameraId, cameraName } = route.params
  const { baseUrl, token } = useAuth()

  const [cameras, setCameras] = useState<Camera[]>([])

  // Set navigation header title
  useEffect(() => {
    navigation.setOptions({ title: cameraName })
  }, [navigation, cameraName])

  // Fetch cameras list on mount for detection camera name resolution
  useEffect(() => {
    if (!baseUrl || !token) return
    void getCameras(baseUrl, token)
      .then(setCameras)
      .catch(() => {
        // Non-fatal; camera name resolution degrades gracefully
      })
  }, [baseUrl, token])

  const { detections } = useDetections([cameraId], cameras)

  const renderItem = useCallback(
    ({ item }: { item: Detection }) => <DetectionCard detection={item} />,
    [],
  )

  const keyExtractor = useCallback((item: Detection) => item.id, [])

  const ListHeader = (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>Detections</Text>
      <Text style={styles.sectionCount}>{detections.length} events</Text>
    </View>
  )

  const ListEmpty = (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No detections yet</Text>
    </View>
  )

  return (
    <View style={styles.container}>
      <FlatList<Detection>
        data={detections}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={
          <>
            <LiveStreamView cameraId={cameraId} cameraName={cameraName} />
            {ListHeader}
          </>
        }
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={styles.listContent}
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
  sectionHeader: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.colors.text,
  },
  sectionCount: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  listContent: {
    paddingBottom: 16,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 32,
  },
  emptyText: {
    fontSize: 15,
    color: tokens.colors.textMuted,
  },
})
