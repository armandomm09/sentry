import React from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'

import type { RootStackParamList } from './types'
import { useAuth } from '../context/AuthContext'
import tokens from '../theme/tokens'

import LoginScreen from '../screens/LoginScreen'
import MainTabNavigator from './MainTabNavigator'

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function AppNavigator(): React.JSX.Element {
  const { token, isLoading } = useAuth()

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={tokens.colors.text} />
      </View>
    )
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {token == null ? (
        <Stack.Screen name="Login" component={LoginScreen} />
      ) : (
        <Stack.Screen name="Main" component={MainTabNavigator} />
      )}
    </Stack.Navigator>
  )
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
