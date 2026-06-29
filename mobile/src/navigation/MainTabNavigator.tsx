import React from 'react'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'

import type { MainTabParamList, HomeStackParamList } from './types'
import tokens from '../theme/tokens'

import HomeScreen from '../screens/HomeScreen'
import CameraDetailScreen from '../screens/CameraDetailScreen'
import AlertsScreen from '../screens/AlertsScreen'
import PersonsScreen from '../screens/PersonsScreen'
import SettingsScreen from '../screens/SettingsScreen'

// ---------------------------------------------------------------------------
// Home Stack
// ---------------------------------------------------------------------------
const HomeStack = createNativeStackNavigator<HomeStackParamList>()

function HomeStackNavigator(): React.JSX.Element {
  return (
    <HomeStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: tokens.colors.bg },
        headerTintColor: tokens.colors.text,
        headerShadowVisible: false,
      }}
    >
      <HomeStack.Screen name="HomeScreen" component={HomeScreen} options={{ title: 'Home' }} />
      <HomeStack.Screen
        name="CameraDetailScreen"
        component={CameraDetailScreen}
        options={{ title: 'Camera' }}
      />
    </HomeStack.Navigator>
  )
}

// ---------------------------------------------------------------------------
// Main Tab Navigator
// ---------------------------------------------------------------------------
const Tab = createBottomTabNavigator<MainTabParamList>()

export default function MainTabNavigator(): React.JSX.Element {
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
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications" size={size ?? 24} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Persons"
        component={PersonsScreen}
        options={{
          title: 'Persons',
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
