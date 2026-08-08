import React from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import tokens from '../theme/tokens'

type Props = {
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  /** Shown below the field when there is no error. */
  hint?: string
  error?: string
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
  keyboardType?: 'default' | 'url' | 'numeric'
  multiline?: boolean
  autoFocus?: boolean
}

/** Labelled text input with hint/error slot, matching the app's dark surfaces. */
export default function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  autoCapitalize = 'sentences',
  keyboardType = 'default',
  multiline = false,
  autoFocus = false,
}: Props): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline, Boolean(error) && styles.inputError]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.colors.textMuted}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        multiline={multiline}
        autoFocus={autoFocus}
      />
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  field: {
    marginBottom: 18,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.colors.textMuted,
    letterSpacing: 0.6,
    marginBottom: 6,
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
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  inputError: {
    borderColor: tokens.colors.danger,
  },
  hint: {
    fontSize: 11,
    color: tokens.colors.textMuted,
    marginTop: 6,
    lineHeight: 15,
  },
  error: {
    fontSize: 11,
    color: tokens.colors.danger,
    marginTop: 6,
  },
})
