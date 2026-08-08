import type { NavigatorScreenParams } from '@react-navigation/native'

import type { Camera, SentryEvent } from '../api/client'

// ---------------------------------------------------------------------------
// Home Stack
// ---------------------------------------------------------------------------
export type HomeStackParamList = {
  HomeScreen: undefined
  CameraDetailScreen: { cameraId: string; cameraName: string }
  /** Omit `camera` to add a new one; pass it to edit that camera. */
  CameraFormScreen: { camera?: Camera } | undefined
}

// ---------------------------------------------------------------------------
// Alerts Stack
// ---------------------------------------------------------------------------
export type AlertsStackParamList = {
  AlertsScreen: undefined
  /** The event travels with the route so the detail view needs no refetch. */
  EventDetailScreen: { event: SentryEvent; cameraName: string }
}

// ---------------------------------------------------------------------------
// Persons Stack
// ---------------------------------------------------------------------------
export type PersonsStackParamList = {
  PersonsScreen: undefined
  PersonDetailScreen: { personId: string; personName: string }
}

// ---------------------------------------------------------------------------
// Root Tab
// ---------------------------------------------------------------------------
export type MainTabParamList = {
  Home: NavigatorScreenParams<HomeStackParamList>
  Alerts: NavigatorScreenParams<AlertsStackParamList>
  Persons: NavigatorScreenParams<PersonsStackParamList>
  Settings: undefined
}

// ---------------------------------------------------------------------------
// Root Stack (auth gate)
// ---------------------------------------------------------------------------
export type RootStackParamList = {
  Login: undefined
  Main: NavigatorScreenParams<MainTabParamList>
}
