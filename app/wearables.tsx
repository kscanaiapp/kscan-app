import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { approvePairing, listWearableSessions, revokeWearableSession, type WearableSession } from '../services/wearables/bridge';

export default function WearablesScreen() {
  const [code, setCode] = useState('');
  const [sessions, setSessions] = useState<WearableSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSessions(await listWearableSessions()); } catch { setNotice('Wearable service is unavailable.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const approve = async () => {
    if (!/^\d{6}$/.test(code) || busy) return;
    setBusy(true); setNotice(null);
    try {
      const paired = await approvePairing(code);
      setCode('');
      setNotice(`${paired.deviceModel || 'Google XR'} approved. Return to the glasses.`);
      await refresh();
    } catch { setNotice('That code is invalid or expired.'); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()}><Text style={styles.back}>‹ HOME</Text></Pressable>
        <Text style={styles.eyebrow}>PRIVATE HARDWARE ALPHA</Text>
        <Text style={styles.title}>Google XR</Text>
        <Text style={styles.copy}>Enter the one-time code shown in the K Scan XR headset. Approval creates a short-lived session; your phone login is never copied to the wearable.</Text>
        <View style={styles.card}>
          <Text style={styles.label}>PAIR CODE</Text>
          <TextInput
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="000000"
            placeholderTextColor="#555568"
            style={styles.input}
          />
          <Pressable style={[styles.button, (!/^\d{6}$/.test(code) || busy) && styles.disabled]} disabled={!/^\d{6}$/.test(code) || busy} onPress={approve}>
            {busy ? <ActivityIndicator color="#050509" /> : <Text style={styles.buttonText}>APPROVE DEVICE</Text>}
          </Pressable>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        </View>
        <Text style={styles.section}>ACTIVE SESSIONS</Text>
        {sessions.length === 0 ? <Text style={styles.empty}>No connected wearable.</Text> : sessions.map((session) => (
          <View key={session.id} style={styles.session}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sessionTitle}>{session.wearable_pairings?.device_model ?? 'K Scan XR'}</Text>
              <Text style={styles.sessionMeta}>Expires {new Date(session.expires_at).toLocaleTimeString()}</Text>
            </View>
            <Pressable onPress={async () => { await revokeWearableSession(session.id); await refresh(); }}><Text style={styles.remove}>REMOVE</Text></Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050509' }, content: { padding: 24, gap: 18 }, back: { color: '#99F6FF', letterSpacing: 2, fontWeight: '700' },
  eyebrow: { color: '#8B5CF6', letterSpacing: 2.5, fontSize: 11, marginTop: 16 }, title: { color: '#F5F7FF', fontSize: 38, fontWeight: '800' },
  copy: { color: '#A9ACB8', fontSize: 15, lineHeight: 23 }, card: { backgroundColor: '#0D0D16', borderColor: '#33205A', borderWidth: 1, borderRadius: 20, padding: 20, gap: 14 },
  label: { color: '#00E5FF', fontSize: 11, letterSpacing: 2 }, input: { color: '#FFFFFF', fontSize: 32, letterSpacing: 12, textAlign: 'center', borderBottomColor: '#40335E', borderBottomWidth: 1, padding: 10 },
  button: { backgroundColor: '#00E5FF', borderRadius: 999, minHeight: 52, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.35 }, buttonText: { color: '#050509', fontWeight: '900', letterSpacing: 1.5 },
  notice: { color: '#C8F8FF', lineHeight: 20 }, section: { color: '#F5F7FF', fontWeight: '800', letterSpacing: 2, marginTop: 8 }, empty: { color: '#737687' },
  session: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D0D16', padding: 16, borderRadius: 16, borderWidth: 1, borderColor: '#202033' },
  sessionTitle: { color: '#F5F7FF', fontWeight: '700' }, sessionMeta: { color: '#7E8190', marginTop: 4 }, remove: { color: '#FF7A9A', fontWeight: '800', letterSpacing: 1 },
});
