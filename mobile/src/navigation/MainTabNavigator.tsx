import React from 'react'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'

import type { MainTabParamList, HomeStackParamList, PersonsStackParamList } from './types'
import tokens from '../theme/tokens'

import HomeScreen from '../screens/HomeScreen'
import CameraDetailScreen from '../screens/CameraDetailScreen'
import CameraFormScreen from '../screens/CameraFormScreen'
import AlertsScreen, { alertsUnreadCountRef } from '../screens/AlertsScreen'
import PersonsScreen from '../screens/PersonsScreen'
import PersonDetailScreen from '../screens/PersonDetailScreen'
import SettingsScreen from '../screens/SettingsScreen'

const stackScreenOptions = {
  headerStyle: { backgroundColor: tokens.colors.bg },
  headerTintColor: tokens.colors.text,
  headerShadowVisible: false,
} as const

// ---------------------------------------------------------------------------
// Home Stack
// ---------------------------------------------------------------------------
const HomeStack = createNativeStackNavigator<HomeStackParamList>()

function HomeStackNavigator(): React.JSX.Element {
  return (
    <HomeStack.Navigator screenOptions={stackScreenOptions}>
      <HomeStack.Screen name="HomeScreen" component={HomeScreen} options={{ title: 'Home' }} />
      <HomeStack.Screen
        name="CameraDetailScreen"
        component={CameraDetailScreen}
        options={{ title: 'Camera' }}
      />
      <HomeStack.Screen
        name="CameraFormScreen"
        component={CameraFormScreen}
        options={{ title: 'Add camera', presentation: 'modal' }}
      />
    </HomeStack.Navigator>
  )
}

// ---------------------------------------------------------------------------
// Persons Stack
// ---------------------------------------------------------------------------
const PersonsStack = createNativeStackNavigator<PersonsStackParamList>()

function PersonsStackNavigator(): React.JSX.Element {
  return (
    <PersonsStack.Navigator screenOptions={stackScreenOptions}>
      <PersonsStack.Screen
        name="PersonsScreen"
        component={PersonsScreen}
        options={{ title: 'Persons' }}
      />
      <PersonsStack.Screen
        name="PersonDetailScreen"
        component={PersonDetailScreen}
        options={{ title: 'Person' }}
      />
    </PersonsStack.Navigator>
  )
}

// ---------------------------------------------------------------------------
// Main Tab Navigator
// ---------------------------------------------------------------------------
const Tab = createBottomTabNavigator<MainTabParamList>()

export default function MainTabNavigator(): React.JSX.Element {
  const [alertsUnread, setAlertsUnread] = React.useState(0)

  React.useEffect(() => {
    alertsUnreadCountRef.onChange = setAlertsUnread
    return () => {
      alertsUnreadCountRef.onChange = null
    }
  }, [])

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: tokens.colors.bg },
        headerTintColor: tokens.colors.text,
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: tokens.colors.surface1,
          borderTopColor: tokens.colors.border,
        },
        tabBarActiveTintColor: tokens.colors.primary,
        tabBarInactiveTintColor: tokens.colors.textMuted,
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeStackNavigator}
        options={{
          headerShown: false,
          tabBarAccessibilityLabel: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size ?? 24} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Alerts"
        component={AlertsScreen}
        options={{
          title: 'Alerts',
          tabBarAccessibilityLabel: 'Alerts',
          tabBarBadge: alertsUnread > 0 ? alertsUnread : undefined,
          tabBarBadgeStyle: { backgroundColor: tokens.colors.primary, fontSize: 10 },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications" size={size ?? 24} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Persons"
        component={PersonsStackNavigator}
        options={{
          headerShown: false,
          tabBarAccessibilityLabel: 'Persons',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people" size={size ?? 24} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarAccessibilityLabel: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-sharp" size={size ?? 24} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  )
}
