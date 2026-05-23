import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
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
  Header,
  ItemTile,
  LoadingOrError,
  PrimaryButton,
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
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
          <PrimaryButton label={saving ? 'Saving' : 'Save Changes'} onPress={handleSave} disabled={!title.trim() || saving} />
          <PrimaryButton label="Cancel" onPress={onClose} variant="secondary" disabled={saving} />
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
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title={look?.title || 'Look'} eyebrow="Look Detail" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={error} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styleObjectStyles.content}>
          {look?.dressingRoomTitle ? <Text style={styles.room}>ROOM: {look.dressingRoomTitle}</Text> : <Text style={styles.room}>STANDALONE LOOK</Text>}
          {look?.description ? <Text style={styles.description}>{look.description}</Text> : null}
          <PrimaryButton label="Edit Look" onPress={() => setEditing(true)} variant="secondary" />
          <View style={styles.items}>
            {items.map((item) => <ItemTile key={item.id} item={item} />)}
          </View>
          <PrimaryButton label="Delete Look" onPress={handleDelete} variant="danger" />
        </ScrollView>
      )}
      <EditLookModal look={look} visible={editing} onClose={() => setEditing(false)} onSaved={reload} />
    </View>
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
  room: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    marginBottom: SPACING.md,
  },
  description: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    marginBottom: SPACING.sm,
  },
  items: {
    marginTop: SPACING.lg,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  modalTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  error: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
});
