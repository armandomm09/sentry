import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { Ionicons } from '@expo/vector-icons'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { PersonsStackParamList } from '../navigation/types'
import {
  deletePerson,
  deletePhoto,
  getPhotos,
  photoUrl,
  renamePerson,
  uploadPhotos,
  type Photo,
} from '../api/client'
import { useAuth } from '../context/AuthContext'
import AuthImage from '../components/AuthImage'
import TextPromptModal from '../components/TextPromptModal'
import tokens from '../theme/tokens'

type Props = NativeStackScreenProps<PersonsStackParamList, 'PersonDetailScreen'>

const GRID_GAP = 8
const NUM_COLUMNS = 3

export default function PersonDetailScreen({ route, navigation }: Props): React.JSX.Element {
  const { baseUrl, token } = useAuth()
  const { personId } = route.params
  const [name, setName] = useState(route.params.personName)

  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  useLayoutEffect(() => {
    navigation.setOptions({ title: name })
  }, [navigation, name])

  const fetchPhotos = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token) return
    try {
      setPhotos(await getPhotos(baseUrl, token, personId))
    } catch {
      // Leave the grid empty — the empty state explains how to add photos.
    } finally {
      setLoading(false)
    }
  }, [baseUrl, token, personId])

  useEffect(() => {
    void fetchPhotos()
  }, [fetchPhotos])

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------
  const handleAddPhotos = useCallback(async (): Promise<void> => {
    if (!baseUrl || !token) return

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(
        'Photo access needed',
        'Allow photo library access in Settings to enroll photos from this device.',
      )
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.9,
    })
    if (result.canceled || result.assets.length === 0) return

    setUploading(true)
    try {
      const res = await uploadPhotos(baseUrl, token, personId, result.assets)
      await fetchPhotos()
      // The face-service rejects photos with no detectable face; surface those
      // per-file rather than failing the whole batch silently.
      if (res.errors.length > 0) {
        const detail = res.errors.map((e) => `${e.filename}: ${e.error}`).join('\n')
        Alert.alert(
          res.added.length > 0 ? 'Some photos were not added' : 'No photos were added',
          detail,
        )
      }
    } catch (err) {
      Alert.alert('Upload failed', err instanceof Error ? err.message : 'Request failed')
    } finally {
      setUploading(false)
    }
  }, [baseUrl, token, personId, fetchPhotos])

  const handleDeletePhoto = useCallback((photo: Photo) => {
    if (!baseUrl || !token) return
    Alert.alert('Remove photo', 'Remove this photo from the enrollment set?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deletePhoto(baseUrl, token, personId, photo.id)
              setPhotos((prev) => prev.filter((p) => p.id !== photo.id))
            } catch (err) {
              Alert.alert('Could not remove', err instanceof Error ? err.message : 'Request failed')
            }
          })()
        },
      },
    ])
  }, [baseUrl, token, personId])

  // ---------------------------------------------------------------------------
  // Person
  // ---------------------------------------------------------------------------
  const [renaming, setRenaming] = useState(false)
  const [savingName, setSavingName] = useState(false)

  const handleRenameSubmit = useCallback((next: string): void => {
    if (!baseUrl || !token) return
    if (next === name) {
      setRenaming(false)
      return
    }
    setSavingName(true)
    void (async () => {
      try {
        await renamePerson(baseUrl, token, personId, next)
        setName(next)
        setRenaming(false)
      } catch (err) {
        Alert.alert('Could not rename', err instanceof Error ? err.message : 'Request failed')
      } finally {
        setSavingName(false)
      }
    })()
  }, [baseUrl, token, personId, name])

  const handleDeletePerson = useCallback(() => {
    if (!baseUrl || !token) return
    Alert.alert(
      'Delete person',
      `Delete "${name}" and all enrolled photos? Future sightings will be reported as unknown.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deletePerson(baseUrl, token, personId)
                navigation.goBack()
              } catch (err) {
                Alert.alert('Could not delete', err instanceof Error ? err.message : 'Request failed')
              }
            })()
          },
        },
      ],
    )
  }, [baseUrl, token, personId, name, navigation])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const renderPhoto = useCallback(({ item }: { item: Photo }) => (
    <Pressable
      style={styles.photoCell}
      onLongPress={() => { handleDeletePhoto(item) }}
      delayLongPress={300}
    >
      <AuthImage
        url={photoUrl(baseUrl ?? '', personId, item.id)}
        fallbackIcon="person-outline"
        style={styles.photo}
      />
    </Pressable>
  ), [baseUrl, personId, handleDeletePhoto])

  const header = (
    <View style={styles.header}>
      <Text style={styles.count}>
        {photos.length} {photos.length === 1 ? 'photo' : 'photos'} enrolled
      </Text>
      <Text style={styles.hint}>Long-press a photo to remove it</Text>

      <Pressable
        style={[styles.addBtn, uploading && styles.addBtnDisabled]}
        onPress={() => { void handleAddPhotos() }}
        disabled={uploading}
      >
        {uploading ? (
          <ActivityIndicator color={tokens.colors.text} />
        ) : (
          <>
            <Ionicons name="add" size={18} color={tokens.colors.text} />
            <Text style={styles.addText}>Add photos</Text>
          </>
        )}
      </Pressable>
    </View>
  )

  const footer = (
    <View style={styles.footer}>
      <Pressable style={styles.secondaryBtn} onPress={() => { setRenaming(true) }}>
        <Ionicons name="pencil" size={16} color={tokens.colors.text} />
        <Text style={styles.secondaryText}>Rename</Text>
      </Pressable>
      <Pressable style={styles.deleteBtn} onPress={handleDeletePerson}>
        <Text style={styles.deleteText}>Delete person</Text>
      </Pressable>
    </View>
  )

  if (loading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={tokens.colors.primary} />
      </View>
    )
  }

  return (
    <>
      <FlatList
        style={styles.root}
        data={photos}
        keyExtractor={(p) => p.id}
        numColumns={NUM_COLUMNS}
        renderItem={renderPhoto}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="images-outline" size={40} color={tokens.colors.textMuted} />
            <Text style={styles.emptyTitle}>No photos yet</Text>
            <Text style={styles.emptySubtitle}>
              Add a few clear photos of this person&apos;s face to enable recognition
            </Text>
          </View>
        }
      />
      <TextPromptModal
        visible={renaming}
        title="Rename person"
        initialValue={name}
        submitting={savingName}
        onCancel={() => { setRenaming(false) }}
        onSubmit={handleRenameSubmit}
      />
    </>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  header: {
    marginBottom: 16,
  },
  count: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.colors.text,
  },
  hint: {
    fontSize: 12,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: tokens.colors.primary,
    borderRadius: tokens.radii.md,
    height: 46,
    marginTop: 14,
  },
  addBtnDisabled: {
    opacity: 0.6,
  },
  addText: {
    color: tokens.colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  column: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  photoCell: {
    flex: 1 / NUM_COLUMNS,
    aspectRatio: 1,
  },
  photo: {
    width: '100%',
    height: '100%',
    borderRadius: tokens.radii.sm,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.colors.text,
    marginTop: 12,
  },
  emptySubtitle: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 6,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  footer: {
    marginTop: 24,
    borderTopWidth: 1,
    borderTopColor: tokens.colors.border,
    paddingTop: 16,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: tokens.colors.surface2,
    borderRadius: tokens.radii.md,
    height: 46,
  },
  secondaryText: {
    color: tokens.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  deleteBtn: {
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  deleteText: {
    color: tokens.colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
})
