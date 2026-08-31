/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 shared bubble block.
 *
 * The seam between the chat bubble and the Concierge surface. It owns exactly
 * two things the pure renderer cannot: the account-scoped image resolution, and
 * the lifecycle rules around it.
 *
 * ACCOUNT SWITCH (matrix row "account switch")
 * --------------------------------------------
 * The image source is rebuilt whenever `ownerId` changes, and any in-flight
 * resolution from the previous account is discarded rather than applied. One
 * account's Closet photo appearing on another account's card would be a
 * privacy failure, not a glitch, so the cancellation is explicit and the state
 * is cleared to empty on the way through -- never left showing stale images
 * while the new ones load.
 *
 * SECTION 45 -- AN ITEM THAT NO LONGER RESOLVES
 * ---------------------------------------------
 * A message persisted earlier can reference an item that has since been
 * deleted. Its image simply fails to resolve and the card renders as text.
 * Nothing here reconstructs chat history or hunts for a replacement image; the
 * neutral state IS the handling.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ConciergeCard, ConciergeResult } from '../../services/concierge/conciergeModel';
import {
  resolveConciergeImages,
  type ConciergeImageState,
} from '../../services/concierge/conciergeImageResolver';
import { createConciergeClosetImageSource } from '../../services/concierge/conciergeClosetImageSource';
import { ConciergeEvidence } from './ConciergeEvidence';

interface Props {
  result: ConciergeResult;
  /** Authenticated owner id. Null -> no resolution is attempted. */
  ownerId: string | null;
  /** Injected FileSystem, so this is testable without a device. */
  fileSystem: { getInfoAsync(uri: string): Promise<{ exists?: boolean; size?: number }> };
  /** Section 40 cross-device fallback. Off unless the host opts in. */
  allowPrivateStoreFallback?: boolean;
  onCardPress?: (card: ConciergeCard) => void;
}

export function ConciergeEvidenceBlock({
  result,
  ownerId,
  fileSystem,
  allowPrivateStoreFallback,
  onCardPress,
}: Props) {
  const [images, setImages] = useState<Record<string, ConciergeImageState>>({});

  // Every clientId this block will draw, focus and look members included.
  // Derived from the model so a look repeating an item does not resolve twice.
  const clientIds = useMemo(() => {
    const ids = [
      result.focusCard?.clientId ?? null,
      ...result.cards.map((card) => card.clientId),
      ...result.looks.flatMap((look) => look.cards.map((card) => card.clientId)),
    ];
    return [...new Set(ids.filter((id): id is string => Boolean(id)))];
  }, [result]);

  // Stable dependency: the array identity changes every render, its contents do
  // not. Keying the effect on the contents stops a resolution loop.
  const clientIdKey = clientIds.join('|');

  useEffect(() => {
    let cancelled = false;

    // Clearing FIRST is deliberate. On an account switch the previous account's
    // resolved URIs must stop being displayed immediately, not when the new
    // resolution happens to finish.
    setImages({});

    if (!ownerId || !clientIds.length) return undefined;

    const source = createConciergeClosetImageSource({
      ownerId,
      fileSystem,
      allowPrivateStoreFallback,
    });

    resolveConciergeImages(source, clientIds)
      .then((resolved) => {
        if (!cancelled) setImages(resolved);
      })
      .catch(() => {
        // Every failure mode is already 'unavailable' inside the resolver; an
        // empty map produces text cards, which is the same correct outcome.
        if (!cancelled) setImages({});
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, clientIdKey, allowPrivateStoreFallback]);

  return (
    <ConciergeEvidence result={result} images={images} onCardPress={onCardPress} />
  );
}
