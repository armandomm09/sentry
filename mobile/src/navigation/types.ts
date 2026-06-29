import type { NavigatorScreenParams } from '@react-navigation/native'

// ---------------------------------------------------------------------------
// Home Stack
// ---------------------------------------------------------------------------
export type HomeStackParamList = {
  HomeScreen: undefined
  CameraDetailScreen: { cameraId: string; cameraName: string }
}

// ---------------------------------------------------------------------------
// Root Tab
// ---------------------------------------------------------------------------
export type MainTabParamList = {
  Home: NavigatorScreenParams<HomeStackParamList>
  Alerts: undefined
  Persons: undefined
  Settings: undefined
}

// ---------------------------------------------------------------------------
// Root Stack (auth gate)
// ---------------------------------------------------------------------------
export type RootStackParamList = {
  Login: undefined
  Main: NavigatorScreenParams<MainTabParamList>
}
