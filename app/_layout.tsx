// La tarea en segundo plano debe definirse al cargar la app (efecto colateral del import).
import '../src/services/BackgroundRefresh';
import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider, useApp } from '../src/state/AppContext';
import { colors, spacing } from '../src/ui/theme';

function Gate() {
  const { ready, initError } = useApp();
  if (initError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: spacing.xl }}>
        <Text style={{ color: colors.danger, fontSize: 16, fontWeight: '700' }}>No se pudo iniciar la app</Text>
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>{initError}</Text>
      </View>
    );
  }
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="pass/[noradId]" options={{ title: 'Pase del satélite' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="light" />
      <Gate />
    </AppProvider>
  );
}
