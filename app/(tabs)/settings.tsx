import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { registerBackgroundRefresh } from '../../src/services/BackgroundRefresh';
import { secureKeys } from '../../src/services/SecureKeys';
import { useApp } from '../../src/state/AppContext';
import { Banner, Button, Card, Chip } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';

function Options<T extends number>({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  format?: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.chips}>
        {options.map((o) => (
          <Chip key={o} label={format ? format(o) : String(o)} active={value === o} onPress={() => onChange(o)} />
        ))}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const { settings, updateSettings, container } = useApp();
  const [n2yo, setN2yo] = useState('');
  const [stUser, setStUser] = useState('');
  const [stPass, setStPass] = useState('');
  const [status, setStatus] = useState<{ spaceTrack: boolean; n2yo: boolean }>({ spaceTrack: false, n2yo: false });
  const [message, setMessage] = useState<string | null>(null);
  const [bg, setBg] = useState<string>('…');

  const refreshStatus = useCallback(async () => setStatus(await secureKeys.status()), []);
  useEffect(() => {
    void refreshStatus();
    registerBackgroundRefresh()
      .then((r) => setBg(r === 'registered' ? 'activo (el sistema decide cuándo corre)' : 'restringido por el sistema'))
      .catch(() => setBg('no disponible'));
  }, [refreshStatus]);

  const saveN2yo = async () => {
    if (!n2yo.trim()) return;
    await secureKeys.setN2yoKey(n2yo);
    setN2yo('');
    setMessage('API key de N2YO guardada en el almacenamiento seguro.');
    await refreshStatus();
  };
  const saveSt = async () => {
    if (!stUser.trim() || !stPass) return;
    await secureKeys.setSpaceTrack(stUser, stPass);
    setStPass('');
    setMessage('Credenciales de Space-Track guardadas en el almacenamiento seguro.');
    await refreshStatus();
  };
  const clearKeys = async () => {
    await secureKeys.clearAll();
    setN2yo('');
    setStUser('');
    setStPass('');
    setMessage('Se borraron todas las credenciales.');
    await refreshStatus();
  };
  const clearCache = async () => {
    await container?.store.clear();
    setMessage('Caché orbital borrada. Se volverá a descargar al consultar.');
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      {message ? <Banner tone="info" text={message} /> : null}

      <Card style={s.card}>
        <Text style={s.h2}>Credenciales de las APIs</Text>
        <Text style={s.hint}>
          Se guardan cifradas en el Keychain/Keystore del dispositivo, nunca en el código. CelesTrak (fuente principal) no
          necesita clave. Space-Track es el fallback; N2YO se usa solo para validar.
        </Text>
        <Text style={s.label}>N2YO · API key {status.n2yo ? '✓ guardada' : '(falta)'}</Text>
        <TextInput value={n2yo} onChangeText={setN2yo} placeholder="XXXXXX-XXXXXX-XXXXXX-XXXX" placeholderTextColor={colors.textMuted} style={s.input} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Button label="Guardar clave de N2YO" variant="ghost" onPress={saveN2yo} disabled={!n2yo.trim()} />
        <Text style={s.label}>Space-Track · cuenta {status.spaceTrack ? '✓ guardada' : '(falta)'}</Text>
        <TextInput value={stUser} onChangeText={setStUser} placeholder="Usuario / email" placeholderTextColor={colors.textMuted} style={s.input} autoCapitalize="none" autoCorrect={false} />
        <TextInput value={stPass} onChangeText={setStPass} placeholder="Contraseña" placeholderTextColor={colors.textMuted} style={s.input} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Button label="Guardar cuenta de Space-Track" variant="ghost" onPress={saveSt} disabled={!stUser.trim() || !stPass} />
        <Button label="Borrar credenciales" variant="danger" onPress={clearKeys} />
      </Card>

      <Card style={s.card}>
        <Text style={s.h2}>Datos orbitales</Text>
        <Options label="Vigencia de la caché (TTL)" value={settings.ttlHours} options={[12, 18, 24]} format={(v) => `${v} h`} onChange={(v) => updateSettings({ ttlHours: v })} />
        <Text style={s.hint}>Las APIs se consultan solo cuando la caché vence; las posiciones se calculan siempre en el dispositivo.</Text>
        <Button label="Borrar caché orbital" variant="ghost" onPress={clearCache} />
      </Card>

      <Card style={s.card}>
        <Text style={s.h2}>Pases y avisos</Text>
        <Options label="Elevación mínima de un pase" value={settings.minElevationDeg} options={[5, 10, 20, 30]} format={(v) => `${v}°`} onChange={(v) => updateSettings({ minElevationDeg: v })} />
        <Options label="Avisar antes del pase" value={settings.notifyMinutes} options={[5, 10, 15, 30]} format={(v) => `${v} min`} onChange={(v) => updateSettings({ notifyMinutes: v })} />
        <Text style={s.hint}>Actualización en segundo plano: {bg}.</Text>
      </Card>

      <Card style={s.card}>
        <Text style={s.h2}>Mapa</Text>
        <Options label="Refresco del marcador" value={settings.positionRefreshSec} options={[1, 2, 5]} format={(v) => `${v} s`} onChange={(v) => updateSettings({ positionRefreshSec: v })} />
        <Options label="Satélites máx. en la capa de constelación" value={settings.constellationLimit} options={[50, 150, 300]} onChange={(v) => updateSettings({ constellationLimit: v })} />
        <Options label="Elevación mínima del footprint" value={settings.footprintMinElevationDeg} options={[0, 5, 10, 20, 30]} format={(v) => `${v}°`} onChange={(v) => updateSettings({ footprintMinElevationDeg: v })} />
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { padding: spacing.lg, gap: spacing.lg },
  card: { gap: spacing.md },
  h2: { color: colors.text, fontSize: 17, fontWeight: '800' },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    height: 46,
    fontSize: 15,
  },
});
