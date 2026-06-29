import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import * as SecureStore from 'expo-secure-store'

// ---------------------------------------------------------------------------
// Secure Store keys
// ---------------------------------------------------------------------------
const KEY_TOKEN = 'sentry_token'
const KEY_USERNAME = 'sentry_username'
const KEY_BASE_URL = 'sentry_base_url'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AuthState = {
  token: string | null
  username: string | null
  baseUrl: string | null
  isLoading: boolean
}

type AuthContextType = AuthState & {
  login: (baseUrl: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const AuthContext = createContext<AuthContextType | undefined>(undefined)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '') // trim trailing slashes
  if (!url.includes('://')) {
    url = `http://${url}`
  }
  return url
}

async function apiLogin(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (!res.ok) {
    let message = 'Connection failed'
    try {
      const json = (await res.json()) as { message?: string }
      if (json.message) message = json.message
    } catch {
      // ignore parse errors — use fallback message
    }
    throw new Error(message)
  }

  const data = (await res.json()) as { token?: string }
  if (!data.token) {
    throw new Error('Connection failed')
  }
  return data.token
}

async function apiLogout(baseUrl: string, token: string): Promise<void> {
  await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>({
    token: null,
    username: null,
    baseUrl: null,
    isLoading: true,
  })

  // Restore persisted session on startup
  useEffect(() => {
    let cancelled = false

    async function restore(): Promise<void> {
      try {
        const [token, username, baseUrl] = await Promise.all([
          SecureStore.getItemAsync(KEY_TOKEN),
          SecureStore.getItemAsync(KEY_USERNAME),
          SecureStore.getItemAsync(KEY_BASE_URL),
        ])

        if (!cancelled) {
          setState({
            token: token ?? null,
            username: username ?? null,
            baseUrl: baseUrl ?? null,
            isLoading: false,
          })
        }
      } catch {
        if (!cancelled) {
          setState({ token: null, username: null, baseUrl: null, isLoading: false })
        }
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(
    async (rawBaseUrl: string, username: string, password: string): Promise<void> => {
      const baseUrl = normalizeBaseUrl(rawBaseUrl)
      const token = await apiLogin(baseUrl, username, password)

      await Promise.all([
        SecureStore.setItemAsync(KEY_TOKEN, token),
        SecureStore.setItemAsync(KEY_USERNAME, username),
        SecureStore.setItemAsync(KEY_BASE_URL, baseUrl),
      ])

      setState({ token, username, baseUrl, isLoading: false })
    },
    [],
  )

  const logout = useCallback(async (): Promise<void> => {
    // Fire-and-forget logout request
    if (state.baseUrl && state.token) {
      void apiLogout(state.baseUrl, state.token).catch(() => undefined)
    }

    await Promise.all([
      SecureStore.deleteItemAsync(KEY_TOKEN),
      SecureStore.deleteItemAsync(KEY_USERNAME),
      SecureStore.deleteItemAsync(KEY_BASE_URL),
    ])

    setState({ token: null, username: null, baseUrl: null, isLoading: false })
  }, [state.baseUrl, state.token])

  const value: AuthContextType = {
    ...state,
    login,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}

export default AuthContext
