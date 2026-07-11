// HELP ME CHOOSE — Dressing Room outfit decisions.
//
// Shared by the owner room screen (role="owner") and the shared-room screen
// for authenticated participants (role="participant"). Public visitors never
// see this component; they get the sanitized read-only preview instead.
//
// Behavior:
//   * Options render item snapshots (real closet images / safe storage refs).
//   * Voting: tap an option's VOTE control; tapping another option changes the
//     vote (server upsert keeps one active vote per user per group).
//   * Owner-only: CHOOSE for winner selection, I'M WEARING THIS after a
//     winner exists, close/reopen. Server enforces owner-only regardless of UI.
//   * Reactions and room messages remain separate systems; votes are the only
//     formal decision input here.
//   * One in-flight guard per mutation; decided/closed groups render calm
//     CHOSEN copy without gamified badges.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { InlineNotice, SectionHeader } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import {
  castOutfitDecisionVote,
  chooseOutfitDecisionWinner,
  confirmWearingOutfitDecision,
  listRoomOutfitDecisions,
  setOutfitDecisionOpenState,
} from '../../services/outfitDecisions';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import type {
  OutfitDecisionDetail,
  OutfitDecisionOptionWithItems,
} from '../../types/styleObjects';

const VARIATION_LABELS: Record<string, string> = {
  reliable: 'Reliable',
  elevated: 'Elevated',
  something_different: 'Something Different',
};

function OptionCard({
  option,
  index,
  isChosen,
  myVote,
  decisionOpen,
  role,
  busy,
  onVote,
  onChoose,
}: {
  option: OutfitDecisionOptionWithItems;
  index: number;
  isChosen: boolean;
  myVote: boolean;
  decisionOpen: boolean;
  role: 'owner' | 'participant';
  busy: boolean;
  onVote: () => void;
  onChoose: () => void;
}) {
  const images = option.items.filter((item) => !!item.imageUrl).slice(0, 4);
  const voteCount = option.voteCount ?? 0;

  return (
    <View style={[styles.optionCard, isChosen && styles.optionCardChosen]}>
      <View style={styles.optionHeader}>
        <Text style={styles.optionLabel}>LOOK {index + 1}</Text>
        {option.variation && VARIATION_LABELS[option.variation] ? (
          <Text style={styles.variationLabel}>{VARIATION_LABELS[option.variation]}</Text>
        ) : null}
      </View>
      {option.title ? (
        <Text style={styles.optionTitle} numberOfLines={1}>
          {option.title}
        </Text>
      ) : null}

      <View style={styles.imageRow}>
        {images.length > 0 ? (
          images.map((item) => (
            <Image
              key={item.id}
              source={{ uri: item.imageUrl as string }}
              style={styles.optionImage}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          ))
        ) : (
          <View style={[styles.optionImage, styles.imageFallback]}>
            <Text style={styles.imageFallbackText}>
              {option.items.length} item{option.items.length === 1 ? '' : 's'}
            </Text>
          </View>
        )}
      </View>

      {option.explanation ? (
        <Text style={styles.explanation} numberOfLines={3}>
          {option.explanation}
        </Text>
      ) : null}

      <View style={styles.optionFooter}>
        <Text style={styles.voteCount} accessibilityLabel={`${voteCount} votes`}>
          {voteCount} vote{voteCount === 1 ? '' : 's'}
        </Text>

        {isChosen ? (
          <Text style={styles.chosenLabel}>CHOSEN</Text>
        ) : decisionOpen ? (
          <View style={styles.footerActions}>
            <TouchableOpacity
              style={[styles.voteButton, myVote && styles.voteButtonActive]}
              onPress={onVote}
              disabled={busy || myVote}
              accessibilityRole="button"
              accessibilityState={{ selected: myVote, disabled: busy || myVote }}
              accessibilityLabel={myVote ? `Voted for Look ${index + 1}` : `Vote for Look ${index + 1}`}
              testID="outfit-vote-button"
            >
              <Text style={[styles.voteButtonText, myVote && styles.voteButtonTextActive]}>
                {myVote ? 'VOTED' : 'VOTE'}
              </Text>
            </TouchableOpacity>
            {role === 'owner' ? (
              <TouchableOpacity
                style={styles.chooseButton}
                onPress={onChoose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Choose Look ${index + 1} as the winner`}
                testID="outfit-choose-button"
              >
                <Text style={styles.chooseButtonText}>CHOOSE</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function OutfitDecisionSection({
  roomId,
  role,
}: {
  roomId: string;
  role: 'owner' | 'participant';
}) {
  const [decisions, setDecisions] = useState<OutfitDecisionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutatingGroupId, setMutatingGroupId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDecisions(await listRoomOutfitDecisions(roomId));
    } catch (err: any) {
      setError(err?.message || 'Unable to load outfit decisions.');
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runMutation = async (groupId: string, action: () => Promise<void>) => {
    if (mutatingGroupId) return; // one in-flight mutation per section
    setMutatingGroupId(groupId);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err: any) {
      setError(err?.message || 'Unable to update this decision. Please try again.');
    } finally {
      setMutatingGroupId(null);
    }
  };

  const handleVote = (detail: OutfitDecisionDetail, option: OutfitDecisionOptionWithItems) => {
    void runMutation(detail.group.id, async () => {
      await castOutfitDecisionVote(detail.group.id, option.id);
    });
  };

  const handleChoose = (detail: OutfitDecisionDetail, option: OutfitDecisionOptionWithItems) => {
    void runMutation(detail.group.id, async () => {
      await chooseOutfitDecisionWinner(detail.group.id, option.id);
      const leader = [...detail.options].sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))[0];
      const overrode = leader && (leader.voteCount ?? 0) > 0 && leader.id !== option.id;
      void recordAiStylistEvent({
        eventType: overrode ? 'owner_overrode_vote_leader' : 'owner_selected_winner',
        signalKey: `${detail.group.id}:${option.id}`,
        payload: {
          occasion: detail.group.occasion ?? null,
          variation: option.variation ?? null,
          optionCount: detail.options.length,
        },
      });
    });
  };

  const handleWearing = (detail: OutfitDecisionDetail) => {
    void runMutation(detail.group.id, async () => {
      await confirmWearingOutfitDecision(detail.group.id);
      void recordAiStylistEvent({
        eventType: 'owner_wearing_confirmed',
        signalKey: detail.group.id,
        payload: { occasion: detail.group.occasion ?? null },
      });
    });
  };

  const handleToggleOpen = (detail: OutfitDecisionDetail) => {
    const reopen = detail.group.status !== 'open';
    void runMutation(detail.group.id, async () => {
      await setOutfitDecisionOpenState(detail.group.id, reopen);
    });
  };

  if (loading) {
    return (
      <View style={styles.section}>
        <SectionHeader title="Help Me Choose" />
        <ActivityIndicator color={LUXURY.colors.plum} />
      </View>
    );
  }

  if (decisions.length === 0 && !error) {
    return null; // No decisions shared yet; keep the room uncluttered.
  }

  return (
    <View style={styles.section} testID="outfit-decision-section">
      <SectionHeader title="Help Me Choose" subtitle="Vote to help decide" />
      {error ? <InlineNotice variant="error" title="Outfit decisions" body={error} /> : null}

      {decisions.map((detail) => {
        const { group, options } = detail;
        const decisionOpen = group.status === 'open';
        const chosenOption = options.find((option) => option.id === group.chosenOptionId) ?? null;
        const chosenIndex = chosenOption ? options.indexOf(chosenOption) : -1;
        const busy = mutatingGroupId === group.id;

        return (
          <View key={group.id} style={styles.groupCard}>
            <Text style={styles.question}>{group.question}</Text>
            {group.occasion ? <Text style={styles.groupMeta}>{group.occasion.toUpperCase()}</Text> : null}

            {options.map((option, index) => (
              <OptionCard
                key={option.id}
                option={option}
                index={index}
                isChosen={group.chosenOptionId === option.id}
                myVote={detail.myVoteOptionId === option.id}
                decisionOpen={decisionOpen}
                role={role}
                busy={busy}
                onVote={() => handleVote(detail, option)}
                onChoose={() => handleChoose(detail, option)}
              />
            ))}

            {chosenOption ? (
              <View style={styles.chosenSummary}>
                <Text style={styles.chosenSummaryLabel}>CHOSEN</Text>
                <Text style={styles.chosenSummaryText}>
                  {group.wearingConfirmedAt
                    ? `I'm wearing Look ${chosenIndex + 1}`
                    : `Look ${chosenIndex + 1} selected`}
                </Text>
                {role === 'owner' && !group.wearingConfirmedAt ? (
                  <TouchableOpacity
                    style={styles.wearingButton}
                    onPress={() => handleWearing(detail)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="I'm wearing this"
                    testID="wearing-this-button"
                  >
                    <Text style={styles.wearingButtonText}>I'M WEARING THIS</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {role === 'owner' ? (
              <TouchableOpacity
                onPress={() => handleToggleOpen(detail)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={decisionOpen ? 'Close this decision' : 'Reopen this decision'}
                style={styles.toggleOpen}
              >
                <Text style={styles.toggleOpenText}>
                  {decisionOpen ? 'Close voting' : 'Reopen voting'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: SPACING.md,
  },
  groupCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  question: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  groupMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  optionCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  optionCardChosen: {
    borderColor: LUXURY.colors.plum,
    borderWidth: 2,
  },
  optionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  optionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  variationLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  optionTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  imageRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  optionImage: {
    flex: 1,
    aspectRatio: 0.8,
    borderRadius: 10,
    backgroundColor: LUXURY.colors.pearl,
    maxWidth: 96,
  },
  imageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  imageFallbackText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  explanation: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  optionFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerActions: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  voteCount: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  voteButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: LUXURY.colors.pearl,
  },
  voteButtonActive: {
    backgroundColor: LUXURY.colors.plum,
  },
  voteButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
  },
  voteButtonTextActive: {
    color: LUXURY.colors.pearl,
  },
  chooseButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.goldBrushed,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  chooseButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 1.4,
  },
  chosenLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 2.2,
  },
  chosenSummary: {
    borderRadius: 14,
    backgroundColor: LUXURY.colors.ivory,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  chosenSummaryLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  chosenSummaryText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  wearingButton: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    backgroundColor: LUXURY.colors.plum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    marginTop: SPACING.xs,
  },
  wearingButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.pearl,
    letterSpacing: 1.4,
  },
  toggleOpen: {
    alignSelf: 'center',
  },
  toggleOpenText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    textDecorationLine: 'underline',
  },
});
