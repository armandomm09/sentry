import { Ionicons } from '@expo/vector-icons'
import React, { useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'

export default function LoginScreen(): React.JSX.Element {
  const { login, isLoading } = useAuth()

  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usernameRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)

  async function handleConnect(): Promise<void> {
    setError(null)
    try {
      await login(serverUrl, username, password)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo area */}
        <View style={styles.logoArea}>
          <Ionicons name="shield-checkmark" size={72} color={tokens.colors.primary} />
          <Text style={styles.appName}>SENTRY</Text>
          <Text style={styles.tagline}>Home Security Intelligence</Text>
        </View>

        {/* Form card */}
        <View style={styles.card}>
          {/* Server URL */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="http://192.168.1.100:8080"
              placeholderTextColor={tokens.colors.textMuted}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => usernameRef.current?.focus()}
            />
          </View>

          {/* Username */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Username</Text>
            <TextInput
              ref={usernameRef}
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="admin"
              placeholderTextColor={tokens.colors.textMuted}
              textContentType="username"
              returnKeyType="next"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordWrapper}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput]}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={tokens.colors.textMuted}
                secureTextEntry={!showPassword}
                textContentType="password"
                returnKeyType="go"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={handleConnect}
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowPassword(v => !v)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={20}
                  color={tokens.colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Connect button */}
          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleConnect}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>Connect to Sentry</Text>
            )}
          </TouchableOpacity>

          {/* Error message */}
          {error !== null && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingBottom: 40,
  },
  // Logo
  logoArea: {
    marginTop: 80,
    marginBottom: 48,
    alignItems: 'center',
  },
  appName: {
    fontSize: 28,
    fontWeight: tokens.fontWeight.bold,
    color: tokens.colors.text,
    letterSpacing: 8,
    marginTop: 12,
  },
  tagline: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 4,
  },
  // Card
  card: {
    backgroundColor: tokens.colors.surface1,
    borderRadius: tokens.radii.lg,
    padding: 24,
    marginHorizontal: 16,
    width: '100%',
    maxWidth: 480,
  },
  // Fields
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginBottom: 6,
  },
  input: {
    backgroundColor: tokens.colors.surface2,
    color: tokens.colors.text,
    borderRadius: 12,
    height: 52,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    fontSize: 15,
  },
  // Password eye toggle
  passwordWrapper: {
    position: 'relative',
  },
  passwordInput: {
    paddingRight: 48,
  },
  eyeButton: {
    position: 'absolute',
    right: 14,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Button
  button: {
    backgroundColor: tokens.colors.primary,
    height: 56,
    borderRadius: 14,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 17,
    fontWeight: tokens.fontWeight.bold,
    color: '#ffffff',
  },
  // Error
  errorText: {
    marginTop: 12,
    textAlign: 'center',
    fontSize: 13,
    color: '#ff6b6b',
  },
})
