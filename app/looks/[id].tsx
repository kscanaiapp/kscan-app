import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { goBackOrHome } from '../../services/navigationExit';
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
import { AI_STYLIST_UI_ENABLED, STYLECHAT_ATTACHMENTS_ENABLED } from '../../constants/featureFlags';
import { ELISE_IDENTITY } from '../../constants/elise';
import { setAttachmentHandoff } from '../../services/style-chat/styleChatAttachmentStore';
import { STYLECHAT_ATTACHMENT_CONTRACT_VERSION } from '../../types/styleChatAttachments';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { deleteLook, getLookDetail, updateLook } from '../../services/styleObjects';
import { AskMyRoomModal } from '../../components/looks/AskMyRoomModal';
import type { Look, LookItem } from '../../types/styleObjects';

const OCCASION_LABELS: Record<string, string> = {
  casual: 'Casual',
  work: 'Work',
  date: 'Date',
  event: 'Event',
  travel: 'Travel',
  other: 'Other',
};

const DRESS_CODE_LABELS: Record<string, string> = {
  relaxed: 'Relaxed',
  smart_casual: 'Smart Casual',
  dressy: 'Dressy',
  formal: 'Formal',
};

const SETTING_LABELS: Record<string, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
  both: 'Indoor & Outdoor',
};

function isOwnedItemLook(look: Look | null): boolean {
  return look?.source === 'manual' || look?.source === 'ai';
}

function contextLine(look: Look): string | null {
  const parts = [
    look.occasion ? OCCASION_LABELS[look.occasion] : null,
    look.dressCode ? DRESS_CODE_LABELS[look.dressCode] : null,
    look.setting ? SETTING_LABELS[look.setting] : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

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
  const [askingRoom, setAskingRoom] = useState(false);
  const { isFeatureEnabled } = useFeatureFreeze();
  const stylistEnabled = AI_STYLIST_UI_ENABLED && isFeatureEnabled('aiStylist');

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
    Alert.alert('Delete this Look?', 'The items in your closet will not be affected.', [
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
        onBack={() => goBackOrHome(router)}
        backLabel="Back"
      />

      {blocking ? (
        <View style={styles.centeredFill}>
          {loading ? (
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          ) : (
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
              {look?.source === 'ai'
                ? 'STYLED BY ELISE FROM YOUR CLOSET'
                : look?.source === 'manual'
                  ? 'BUILT FROM YOUR CLOSET'
                  : look?.dressingRoomTitle
                    ? `ROOM: ${look.dressingRoomTitle}`
                    : 'STANDALONE LOOK'}
            </Text>
            {look && contextLine(look) ? (
              <Text style={styles.contextLine}>{contextLine(look)}</Text>
            ) : null}
            {look?.contextNote ? <Text style={styles.description}>{look.contextNote}</Text> : null}
            {look?.description ? <Text style={styles.description}>{look.description}</Text> : null}
            {look?.source === 'ai' && look.explanation ? (
              <View style={styles.whyCard}>
                <Text style={styles.whyLabel}>WHY IT WORKS</Text>
                <Text style={styles.whyText}>{look.explanation}</Text>
              </View>
            ) : null}
            <SecondaryButton
              title="Edit Look"
              onPress={() => {
                if (isOwnedItemLook(look) && stylistEnabled) {
                  router.push(`/looks/create?lookId=${look?.id}`);
                } else {
                  setEditing(true);
                }
              }}
              accessibilityLabel="Edit look"
            />
            {stylistEnabled && look ? (
              <PrimaryButton
                title="Ask My Room"
                onPress={() => setAskingRoom(true)}
                accessibilityLabel="Ask my room"
                testID="ask-my-room-button"
              />
            ) : null}
            {stylistEnabled && STYLECHAT_ATTACHMENTS_ENABLED && look ? (
              <SecondaryButton
                title="Ask Elise"
                onPress={() => {
                  // One-time handoff; preloads the unsent composer draft and
                  // never auto-sends (Part 6 / Part 29).
                  setAttachmentHandoff({
                    resolved: {
                      attachmentType: 'look',
                      lookId: look.id,
                      contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
                    },
                    summary: {
                      title: look.title,
                      subtitle: look.occasion ?? null,
                      imageUri: look.coverImageUrl ?? null,
                      itemCount: items.length || 1,
                    },
                    createdAt: new Date().toISOString(),
                  });
                  router.push('/style-chat');
                }}
                accessibilityLabel={ELISE_IDENTITY.askAboutLookLabel}
                testID="ask-stylechat-look"
              />
            ) : null}
            {stylistEnabled && isOwnedItemLook(look) ? (
              <SecondaryButton
                title="Style Again"
                onPress={() =>
                  router.push(
                    `/stylist?occasion=${encodeURIComponent(look?.occasion ?? '')}&dressCode=${encodeURIComponent(look?.dressCode ?? '')}`,
                  )
                }
                accessibilityLabel="Style again"
              />
            ) : null}
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

      {look ? (
        <AskMyRoomModal
          visible={askingRoom}
          lookIds={[look.id]}
          onClose={() => setAskingRoom(false)}
          onShared={({ roomId }) => {
            router.push(`/dressing-rooms/${roomId}`);
          }}
        />
      ) : null}

      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
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
  contextLine: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  whyCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  whyLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  whyText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
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
