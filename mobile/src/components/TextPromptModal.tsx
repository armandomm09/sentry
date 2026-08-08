import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import tokens from '../theme/tokens'

type Props = {
  visible: boolean
  title: string
  placeholder?: string
  /** Pre-filled value, e.g. the current name when renaming. */
  initialValue?: string
  confirmLabel?: string
  submitting?: boolean
  onCancel: () => void
  onSubmit: (value: string) => void
}

/**
 * Single-field text prompt.
 *
 * `Alert.prompt` would be shorter but is iOS-only — on Android it renders
 * nothing and the callback never fires, so naming flows would silently break.
 */
export default function TextPromptModal({
  visible,
  title,
  placeholder,
  initialValue = '',
  confirmLabel = 'Save',
  submitting = false,
  onCancel,
  onSubmit,
}: Props): React.JSX.Element {
  const [value, setValue] = useState(initialValue)

  // Reset to the caller's value each time the sheet opens.
  useEffect(() => {
    if (visible) setValue(initialValue)
  }, [visible, initialValue])

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={tokens.colors.textMuted}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => { if (canSubmit) onSubmit(trimmed) }}
          />
          <View style={styles.actions}>
            <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={submitting}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.confirmBtn, !canSubmit && styles.confirmDisabled]}
              onPress={() => { onSubmit(trimmed) }}
              disabled={!canSubmit}
            >
              {submitting ? (
                <ActivityIndicator color={tokens.colors.text} size="small" />
              ) : (
                <Text style={styles.confirmText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    backgroundColor: tokens.colors.surface1,
    borderRadius: tokens.radii.lg,
    padding: 20,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.colors.text,
    marginBottom: 14,
  },
  input: {
    backgroundColor: tokens.colors.surface2,
    borderRadius: tokens.radii.md,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: tokens.colors.text,
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: tokens.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  confirmBtn: {
    flex: 1,
    height: 44,
    borderRadius: tokens.radii.md,
    backgroundColor: tokens.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmText: {
    color: tokens.colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
})
