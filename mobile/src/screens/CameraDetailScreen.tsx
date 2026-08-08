import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { HomeStackParamList } from '../navigation/types'
import type { Camera, StreamMap } from '../api/client'
import { getCameras, getStreams, startStream, stopStream } from '../api/client'
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

  useEffect(() => {
    navigation.setOptions({ title: cameraName })
  }, [navigation, cameraName])

  useEffect(() => {
    if (!baseUrl || !token) return
    void getCameras(baseUrl, token)
      .then(setCameras)
      .catch(() => {
        // Non-fatal; camera name resolution degrades gracefully
      })
  }, [baseUrl, token])

  // Stream state drives the start/stop control; the dashboard has the same pair.
  const [streams, setStreams] = useState<StreamMap>({})
  const [toggling, setToggling] = useState(false)

  const refreshStreams = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token) return
    try {
      setStreams(await getStreams(baseUrl, token))
    } catch {
      // Non-fatal; the control falls back to showing "start".
    }
  }, [baseUrl, token])

  useEffect(() => {
    void refreshStreams()
  }, [refreshStreams])

  const isLive = streams[cameraId]?.status === 'live'

  const handleToggleStream = useCallback((): void => {
    if (!baseUrl || !token) return
    setToggling(true)
    void (async () => {
      try {
        if (isLive) await stopStream(baseUrl, token, cameraId)
        else await startStream(baseUrl, token, cameraId)
        await refreshStreams()
      } catch (err) {
        Alert.alert(
          isLive ? 'Could not stop stream' : 'Could not start stream',
          err instanceof Error ? err.message : 'Request failed',
        )
      } finally {
        setToggling(false)
      }
    })()
  }, [baseUrl, token, cameraId, isLive, refreshStreams])

  const { detections, liveBboxes } = useDetections([cameraId], cameras)

  const camera = cameras.find((c) => c.id === cameraId)

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
      <Text style={styles.emptyText}>No detection yet</Text>
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
            <LiveStreamView
              cameraId={cameraId}
              cameraName={cameraName}
              showDetections={camera?.face_recognition_enabled ?? false}
              liveBboxes={liveBboxes}
            />
            <View style={styles.controls}>
              <Pressable
                style={[styles.streamBtn, isLive && styles.streamBtnStop, toggling && styles.streamBtnBusy]}
                onPress={handleToggleStream}
                disabled={toggling}
              >
                {toggling ? (
                  <ActivityIndicator size="small" color={tokens.colors.text} />
                ) : (
                  <>
                    <Ionicons
                      name={isLive ? 'stop' : 'play'}
                      size={16}
                      color={tokens.colors.text}
                    />
                    <Text style={styles.streamBtnText}>
                      {isLive ? 'Stop stream' : 'Start stream'}
                    </Text>
                  </>
                )}
              </Pressable>
              {camera && (
                <Pressable
                  style={styles.editBtn}
                  onPress={() => { navigation.navigate('CameraFormScreen', { camera }) }}
                >
                  <Ionicons name="settings-outline" size={16} color={tokens.colors.text} />
                  <Text style={styles.streamBtnText}>Edit</Text>
                </Pressable>
              )}
            </View>
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
  controls: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  streamBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.primary,
  },
  streamBtnStop: {
    backgroundColor: tokens.colors.surface2,
  },
  streamBtnBusy: {
    opacity: 0.6,
  },
  streamBtnText: {
    color: tokens.colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    paddingHorizontal: 16,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.surface2,
  },
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
