import React from 'react'
import { Text, View } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { Ionicons } from '@expo/vector-icons'

import { AuthProvider } from './src/context/AuthContext'
import AppNavigator from './src/navigation/AppNavigator'
import tokens from './src/theme/tokens'

// ---------------------------------------------------------------------------
// Foreground notification banner — must live inside SafeAreaProvider
// ---------------------------------------------------------------------------
interface BannerData {
  title: string
  body: string
}

function NotificationBanner(): React.JSX.Element | null {
  const insets = useSafeAreaInsets()
  const [banner, setBanner] = React.useState<BannerData | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(notif => {
      const title = notif.request.content.title ?? ''
      const body = notif.request.content.body ?? ''
      setBanner({ title, body })
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setBanner(null), 4000)
    })
    return () => {
      sub.remove()
      clearTimeout(timerRef.current)
    }
  }, [])

  if (!banner) return null

  return (
    <View
      style={{
        position: 'absolute',
        top: insets.top + 8,
        left: 16,
        right: 16,
        backgroundColor: tokens.colors.primary,
        borderRadius: 12,
        padding: 12,
        flexDirection: 'row',
        alignItems: 'center',
        zIndex: 9999,
      }}
    >
      <Ionicons name="notifications" size={20} color="#fff" style={{ marginRight: 8 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{banner.title}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 2 }}>
          {banner.body}
        </Text>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer>
          <StatusBar style="light" />
          <AppNavigator />
          <NotificationBanner />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  )
}
