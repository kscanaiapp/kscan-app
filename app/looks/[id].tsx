import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import {
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  SavedLookCard,
  InlineNotice,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
  PrivacyFooter,
} from '../../components/luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { deleteLook, getLookDetail, updateLook } from '../../services/styleObjects';
import type { Look, LookItem } from '../../types/styleObjects';

function EditLookModal({
  look,
  visible,
  onClose,
  onSaved,
}: {
  look: Look | null;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(look?.title ?? '');
    setDescription(look?.description ?? '');
    setError(null);
  }, [look, visible]);

  const handleSave = async () => {
    if (!look || !title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateLook(look.id, { title, description });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Unable to update Look.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Edit Look</Text>
          <TextField label="Title" value={title} onChangeText={setTitle} />
          <TextField label="Description" value={description} onChangeText={setDescription} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            title={saving ? 'Saving' : 'Save Changes'}
            onPress={handleSave}
            disabled={!title.trim() || saving}
          />
          <SecondaryButton title="Cancel" onPress={onClose} disabled={saving} />
        </View>
      </View>
    </Modal>
  );
}

function LookDetailContent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lookId = String(id || '');
  const [look, setLook] = useState<Look | null>(null);
  const [items, setItems] = useState<LookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const reload = useCallback(async () => {
    if (!lookId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getLookDetail(lookId);
      setLook(detail.look);
      setItems(detail.items);
    } catch (err: any) {
      setError(err?.message || 'Unable to load Look.');
    } finally {
      setLoading(false);
    }
  }, [lookId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = () => {
    if (!look) return;
    Alert.alert('Delete Look?', 'This removes the Look and its copied item snapshots.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteLook(look.id);
            router.replace('/looks');
          } catch (err: any) {
            Alert.alert('Could not delete Look', err?.message || 'Try again.');
          }
        },
      },
    ]);
  };

  const blocking = loading || !!error;

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title={look?.title || 'Look'}
        subtitle="LOOK DETAIL"
        onBack={() => router.back()}
        backLabel="Back"
      />

      {blocking ? (
        <View style={styles.centeredFill}>
          {loading ? null : (
            <InlineNotice
              variant="error"
              title="Unable to load Look"
              body={error || 'Something went wrong. Please try again.'}
              action={{ label: 'Retry', onPress: reload, accessibilityLabel: 'Retry loading look' }}
            />
          )}
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.metaCard}>
            <Text style={styles.roomLabel}>
              {look?.dressingRoomTitle ? `ROOM: ${look.dressingRoomTitle}` : 'STANDALONE LOOK'}
            </Text>
            {look?.description ? <Text style={styles.description}>{look.description}</Text> : null}
            <SecondaryButton
              title="Edit Look"
              onPress={() => setEditing(true)}
              accessibilityLabel="Edit look"
            />
          </View>

          <SectionHeader title="Items" subtitle={`${items.length} saved item${items.length === 1 ? '' : 's'}`} />

          <View style={styles.items}>
            {items.map((item) => (
              <SavedLookCard
                key={item.id}
                imageUrl={item.imageUrl}
                title={item.title || 'Untitled item'}
                subtitle={item.brand || item.category || 'K Scan'}
                tags={[item.category].filter(Boolean) as string[]}
                status="Item"
                accessibilityLabel={`${item.title || 'Untitled item'} look item`}
              />
            ))}
          </View>

          <TertiaryButton
            title="Delete Look"
            onPress={handleDelete}
            textStyle={{ color: LUXURY.colors.error }}
            accessibilityLabel="Delete look"
            accessibilityHint="Permanently delete this look"
          />
        </ScrollView>
      )}

      <EditLookModal look={look} visible={editing} onClose={() => setEditing(false)} onSaved={reload} />

      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/support')}
      />
    </LuxuryScreen>
  );
}

export default function LookDetailScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!isFeatureEnabled('outfitRemixLooks')) {
    return <FeatureFreezeFallback cta="closet" />;
  }

  return <LookDetailContent />;
}

const styles = StyleSheet.create({
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  metaCard: {
    ...LUXURY.cards.hero,
    gap: SPACING.md,
  },
  roomLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  description: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  items: {
    gap: SPACING.md,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: LUXURY.cards.screen.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...LUXURY.cards.screen.shadow,
  },
  modalTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  error: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    textAlign: 'center',
  },
});
