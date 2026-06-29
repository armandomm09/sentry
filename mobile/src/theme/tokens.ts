import { StyleSheet } from 'react-native'

const tokens = {
  colors: {
    // Backgrounds
    bgPrimary: '#0d0d0d',
    bgSecondary: '#1a1a1a',
    bgCard: '#242424',
    bgOverlay: 'rgba(0,0,0,0.6)',

    // Brand / accent
    accent: '#00c2ff',
    accentDim: '#0099cc',

    // Status
    live: '#22c55e',
    reconnecting: '#f59e0b',
    error: '#ef4444',
    warning: '#f59e0b',
    success: '#22c55e',

    // Text
    textPrimary: '#f5f5f5',
    textSecondary: '#a3a3a3',
    textDisabled: '#525252',
    textInverse: '#0d0d0d',

    // Borders / dividers
    border: '#2e2e2e',
    borderFocus: '#00c2ff',

    // Interactive
    buttonPrimary: '#00c2ff',
    buttonPrimaryText: '#0d0d0d',
    buttonDestructive: '#ef4444',
    buttonDestructiveText: '#f5f5f5',

    // Transparent
    transparent: 'transparent',
  },

  radii: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    full: 9999,
  },

  spacing: {
    '0': 0,
    '1': 4,
    '2': 8,
    '3': 12,
    '4': 16,
    '5': 20,
    '6': 24,
    '8': 32,
    '10': 40,
    '12': 48,
    '16': 64,
  },

  fontSize: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
    '4xl': 36,
  },

  fontWeight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
} as const

export default tokens

// Flat StyleSheet-friendly aliases (string values required by RN StyleSheet)
export const flat = StyleSheet.create({
  // intentionally empty — consumers import tokens directly
  _placeholder: {},
})
