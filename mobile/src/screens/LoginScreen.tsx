import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import tokens from '../theme/tokens'

export default function LoginScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>LoginScreen</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: tokens.colors.text,
    fontSize: tokens.fontSize.lg,
  },
})
