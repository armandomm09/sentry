import { StyleSheet } from 'react-native'

const tokens = {
  colors: {
    primary:   '#e83a29',
    bg:        '#0f0f0f',
    surface1:  '#1c1c1e',
    surface2:  '#2c2c2e',
    text:      '#ffffff',
    textMuted: '#8e8e93',
    online:    '#30d158',
    warning:   '#ff9f0a',
    danger:    '#e83a29',
    border:    '#3a3a3c',
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
