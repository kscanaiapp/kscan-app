import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Linking,
  Animated,
  Modal,
  ActivityIndicator,
  TextInput,
  Alert,
  type ImageStyle,
} from 'react-native';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { MODAL_MAX_WIDTH } from '../services/responsiveLayout';
import { selectionTick } from '../services/haptics';
import { selectCommerceDestination } from '../services/commerceDestination';
import { PRODUCT_TITLE_UNAVAILABLE } from '../services/privateSavedLookCopy';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { useDressingRooms } from '../hooks/useStyleObjects';
import {
  addProductToDressingRoom,
  createDressingRoom,
  isRemoteImageUrl,
  UnsupportedStyleObjectItemError,
} from '../services/styleObjects';
import type { ProductMatchSnapshotSource } from '../types/styleObjects';
import { toSnapshotPrice, normalizeForSnapshot } from '../src/utils/productSnapshot';
import { KPlusGate } from './kplus/KPlusGate';
import { emitKPlusEvent } from '../services/kplus/kplusTelemetry';
import { createWatch } from '../services/watchlist/watchlistClient';
import { requestWatchAlerts } from '../services/watchlist/pushRegistration';
import type { WatchIntent } from '../types/watchlist';
import {
  formatCommercePrice,
  normalizePersistedCommerceUrl,
  openPersistedCommerceUrl,
} from '../services/dressingRoomCommerce';
import { VTO_UI_ENABLED } from '../constants/featureFlags';
import { TryItOnEntry } from './vto/TryItOnEntry';
import { buildVtoGarmentFromCommerceRecord } from '../services/vto/vtoCommerceGarment';
import type { VtoGarmentInput } from '../types/vto';

export interface Product {
  id?:         string;
  displayName?: string;
  title?:      string;
  name?:       string;
  product_name?: string;
  retailer?:   string;
  brand?:      string;
  source?:     string;
  merchant?:   string;
  store?:      string;
  price?:      string | number | null;
  currency?:   string;
  imageUrl?:   string | null;
  image_url?:  string | null;
  thumbnail?:  string | null;
  thumbnailUrl?: string | null;
  image_src?:  string | null;
  product_image_url?: string | null;
  imageCategory?: string | null;
  category?:   string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  purchase_url?: string | null;
  product_url?: string | null;
  url?:        string | null;
  link?:       string | null;
  affiliateUrl?: string | null;
  availability?: string | null;
  matchScore?: number;
  similarityPercentage?: number;
  /** K5-C1, server-authored. Only 'refreshable_listing' may be watched. */
  watchCapability?: 'refreshable_listing' | 'unsupported';
  type?: 'retail' | 'similar';
  commerceType?: 'retail' | 'resale';
}

interface ProductShelfProps {
  products: Product[];
  /** Section heading. Defaults to the catalog similarity shelf label. */
  label?: string;
  /** Copy shown when `products` is empty. */
  emptyTitle?: string;
  emptyBody?: string;
  testID?: string;
  /**
   * v127 (P1-B): deferred commerce is still in flight. Only meaningful when
   * `products` is empty — a non-empty shelf already has something to show and
   * takes precedence, matching the caller-side "at least one option" gate.
   */
  pending?: boolean;
  /** v127 (P1-B): deferred commerce failed. Same precedence as `pending`. */
  hasError?: boolean;
  errorTitle?: string;
  errorBody?: string;
  /** Present only when a failed fetch is retryable. */
  onRetry?: () => void;
}

const CARD_WIDTH  = 144;
const IMAGE_SIZE  = CARD_WIDTH;
const PLACEHOLDER_CATEGORIES = new Set([
  'footwear',
  'outerwear',
  'tops',
  'bottoms',
  'dresses',
  'accessories',
]);

function normalizeImageCategory(category: string | null | undefined) {
  const normalized = String(category || '').toLowerCase().trim();
  return PLACEHOLDER_CATEGORIES.has(normalized) ? normalized : 'accessories';
}

function getProductTitle(product: Product | null | undefined): string {
  if (!product) return '';
  return (
    String(product.displayName || product.name || product.title || product.product_name || '').trim()
  );
}

function getProductImageUrl(product: Product | null | undefined): string | null {
  if (!product) return null;
  const candidates = [
    product.imageUrl,
    product.image_url,
    product.thumbnail,
    product.thumbnailUrl,
    product.image_src,
    product.product_image_url,
  ];
  for (const c of candidates) {
    const safeUrl = normalizePersistedCommerceUrl(c);
    if (safeUrl) return safeUrl;
  }
  return null;
}

function getPurchaseUrl(product: Product | null | undefined): string | null {
  if (!product) return null;
  // Order is intentionally not the selector: a record can hold a retailer link
  // in any of these keys and a search-engine page in any other, so the
  // destination itself decides. Each candidate keeps the persisted-URL scrub
  // (signed object paths, credential-shaped params) before it is considered.
  return selectCommerceDestination(
    [
      product.productUrl,
      product.purchaseUrl,
      product.affiliateUrl,
      product.product_url,
      product.purchase_url,
      product.url,
      product.link,
    ].map((candidate) => normalizePersistedCommerceUrl(candidate)),
  );
}

function getRetailer(product: Product | null | undefined): string | null {
  if (!product) return null;
  const candidates = [product.retailer, product.brand, product.source, product.merchant, product.store];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function formatPrice(product: Product | null | undefined): string | null {
  if (!product) return null;
  return formatCommercePrice(product.price, product.currency);
}

export function canAddProductToDressingRoom(product: Product | null | undefined) {
  return getProductTitle(product).length > 0 && isRemoteImageUrl(getProductImageUrl(product));
}

/** K5-C5: the Watch action only ever appears on a server-marked-eligible listing. */
export function canWatchProduct(product: Product | null | undefined): boolean {
  return product?.watchCapability === 'refreshable_listing';
}

/**
 * Narrows a commerce candidate into the VTO garment contract.
 *
 * VTO-REACH-001: the body of this moved to services/vto/vtoCommerceGarment.ts
 * so the LIVE Scan Results V2 surface can build the identical garment. This
 * shelf is not the shipped scan surface -- ScanResultV2 is -- and two
 * derivations would be exactly how "Product A's try-on" becomes Product B's.
 *
 * Kept as a named export with its Product-shaped signature so every existing
 * caller and test is unaffected. The field precedence is unchanged; it simply
 * lives in one place now.
 */
export function buildVtoGarmentFromProduct(
  product: Product | null | undefined,
): VtoGarmentInput | null {
  return buildVtoGarmentFromCommerceRecord(product as Record<string, unknown> | null | undefined);
}

/**
 * v127 (P1-B): which empty-shelf treatment to render when there are no
 * products. Pulled out of the JSX branch so this exact precedence is
 * independently testable — a pure decision, not a parallel copy of it.
 *
 * `pending` wins over `hasError`: a stale error from a settled attempt must
 * not outlive a fresh dispatch (e.g. a retry) that is now in flight.
 */
export function resolveEmptyShelfMode(pending: boolean, hasError: boolean): 'pending' | 'error' | 'empty' {
  if (pending) return 'pending';
  if (hasError) return 'error';
  return 'empty';
}

function ProductImagePlaceholder({ category }: { category: string }) {
  if (category === 'footwear') {
    return (
      <View style={styles.placeholderMark}>
        <View style={[styles.footwearUpper, styles.placeholderStroke]} />
        <View style={[styles.footwearSole, styles.placeholderGoldStroke]} />
        <View style={[styles.footwearHeel, styles.placeholderCyanFill]} />
      </View>
    );
  }

  if (category === 'outerwear') {
    return (
      <View style={styles.placeholderMark}>
        <View style={[styles.outerwearBody, styles.placeholderStroke]} />
        <View style={[styles.outerwearLapels, styles.placeholderGoldStroke]} />
        <View style={[styles.outerwearSleeveLeft, styles.placeholderCyanStroke]} />
        <View style={[styles.outerwearSleeveRight, styles.placeholderCyanStroke]} />
      </View>
    );
  }

  if (category === 'tops') {
    return (
      <View style={styles.placeholderMark}>
        <View style={[styles.topsBody, styles.placeholderStroke]} />
        <View style={[styles.topsCollar, styles.placeholderGoldStroke]} />
        <View style={[styles.topsSleeveLeft, styles.placeholderCyanStroke]} />
        <View style={[styles.topsSleeveRight, styles.placeholderCyanStroke]} />
      </View>
    );
  }

  if (category === 'bottoms') {
    return (
      <View style={styles.placeholderMark}>
        <View style={[styles.bottomsWaist, styles.placeholderGoldStroke]} />
        <View style={[styles.bottomsLegLeft, styles.placeholderStroke]} />
        <View style={[styles.bottomsLegRight, styles.placeholderStroke]} />
      </View>
    );
  }

  if (category === 'dresses') {
    return (
      <View style={styles.placeholderMark}>
        <View style={[styles.dressBodice, styles.placeholderGoldStroke]} />
        <View style={[styles.dressSkirt, styles.placeholderStroke]} />
        <View style={[styles.dressHem, styles.placeholderCyanStroke]} />
      </View>
    );
  }

  return (
    <View style={styles.placeholderMark}>
      <View style={[styles.accessoryBody, styles.placeholderStroke]} />
      <View style={[styles.accessoryHandle, styles.placeholderGoldStroke]} />
      <View style={[styles.accessoryClasp, styles.placeholderCyanFill]} />
    </View>
  );
}

function CatalogProductImage({
  uri,
  productKey,
  imageCategory,
  onError,
}: {
  uri: string;
  productKey: string;
  imageCategory: string;
  onError: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  return (
    <View style={styles.image}>
      <View style={[styles.image, styles.imageSkeleton]} />
      <Animated.Image
        source={{ uri }}
        style={[styles.productImage as ImageStyle, { opacity }]}
        resizeMode="cover"
        onLoad={() => {
          Animated.timing(opacity, {
            toValue: 1,
            duration: 180,
            useNativeDriver: true,
          }).start();
        }}
        onError={() => {
          if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(
              '[K-SCAN ProductShelf] image load failed',
              JSON.stringify({
                productKey,
                category: imageCategory,
              }),
            );
          }
          onError();
        }}
      />
    </View>
  );
}

export function ProductShelf({
  products,
  label = 'SIMILAR ITEMS',
  emptyTitle = 'No similar items yet.',
  emptyBody = 'Try a clearer angle, closer crop, or simpler background so K Scan AI can surface product matches.',
  testID,
  pending = false,
  hasError = false,
  errorTitle = 'Could not load purchase options.',
  errorBody = 'Check your connection and try again.',
  onRetry,
}: ProductShelfProps) {
  const [linkErrorVisible, setLinkErrorVisible] = useState(false);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [watchModalProduct, setWatchModalProduct] = useState<Product | null>(null);
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');

  if (!products || products.length === 0) {
    const emptyMode = resolveEmptyShelfMode(pending, hasError);
    if (emptyMode === 'pending') {
      return (
        <View testID={testID ? `${testID}-pending` : 'product-shelf-pending'} style={styles.emptyShelf}>
          <ActivityIndicator color={LUXURY.colors.plum} />
        </View>
      );
    }
    if (emptyMode === 'error') {
      return (
        <View testID={testID ? `${testID}-error` : 'product-shelf-error'} style={styles.emptyShelf}>
          <Text style={styles.emptyShelfTitle}>{errorTitle}</Text>
          <Text style={styles.emptyShelfBody}>{errorBody}</Text>
          {onRetry ? (
            <TouchableOpacity
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel="Retry loading purchase options"
              testID={testID ? `${testID}-retry` : 'product-shelf-retry'}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      );
    }
    return (
      <View testID={testID ? `${testID}-empty` : 'product-shelf-empty'} style={styles.emptyShelf}>
        <Text style={styles.emptyShelfTitle}>{emptyTitle}</Text>
        <Text style={styles.emptyShelfBody}>{emptyBody}</Text>
      </View>
    );
  }

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const missingImage = products.filter((p) => !getProductImageUrl(p)).length;
    const missingLink = products.filter((p) => !getPurchaseUrl(p)).length;
    console.log('[K-SCAN ProductShelf] rendering products=' + products.length +
      ' missingImageUrl=' + missingImage + ' missingProductUrl=' + missingLink);
  }

  const handleLinkPress = (url: string | null | undefined) => {
    if (!url) return;
    selectionTick();
    void openPersistedCommerceUrl(url, (safeUrl) => Linking.openURL(safeUrl)).then((opened) => {
      if (!opened) {
        setLinkErrorVisible(true);
        setTimeout(() => setLinkErrorVisible(false), 2000);
      }
    });
  };

  return (
    <View testID={testID ?? 'product-shelf'} style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.labelLine} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {products.map((p, i) => {
          const productImageUrl = getProductImageUrl(p);
          const purchaseUrl = getPurchaseUrl(p);
          const hasLink = !!purchaseUrl;
          const productKey = p.id ?? String(i);
          // A product that arrives without a usable name is a gap in OUR data,
          // not a mystery object. "Unknown Product" reads as an accusation about
          // the item; this says what is actually true for the shopper.
          const productTitle = getProductTitle(p) || PRODUCT_TITLE_UNAVAILABLE;
          const canSaveToRoom = canAddProductToDressingRoom(p);
          const canWatch = canWatchProduct(p);
          const imageCategory = normalizeImageCategory(p.imageCategory || p.category);
          const showImage = !!productImageUrl && !failedImages[productKey];
          const retailer = getRetailer(p);
          const priceText = formatPrice(p);
          const vtoGarment = buildVtoGarmentFromProduct(p);
          const availability = typeof p.availability === 'string' ? p.availability.toLowerCase() : null;
          const isOutOfStock = availability === 'out_of_stock' || availability === 'out of stock';
          if (typeof __DEV__ !== 'undefined' && __DEV__ && !showImage) {
            console.log(
              '[K-SCAN ProductShelf] fallback',
              JSON.stringify({
                name: productTitle,
                hasImageUrl: !!productImageUrl,
                category: imageCategory,
              }),
            );
          }
          return (
            <View
              key={productKey}
              style={[styles.card, !hasLink && styles.cardNoLink]}
            >
              <TouchableOpacity
                onPress={() => handleLinkPress(purchaseUrl)}
                activeOpacity={hasLink ? 0.78 : 1}
                disabled={!hasLink}
                accessibilityRole={hasLink ? 'link' : 'button'}
                accessibilityLabel={hasLink ? `Open ${productTitle} product page` : `${productTitle} product image`}
                accessibilityHint={hasLink ? 'Opens the retailer product page' : undefined}
              >
                {showImage ? (
                  <CatalogProductImage
                    uri={productImageUrl}
                    productKey={productKey}
                    imageCategory={imageCategory}
                    onError={() => setFailedImages((current) => ({ ...current, [productKey]: true }))}
                  />
                ) : (
                  <View
                    style={[styles.image, styles.imagePlaceholder]}
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={`Catalog image unavailable for ${productTitle}`}
                  >
                    <ProductImagePlaceholder category={imageCategory} />
                    <Text style={styles.placeholderLabel} numberOfLines={1}>
                      Image pending
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              <View style={styles.cardBody}>
                {retailer ? (
                  <Text style={styles.retailer} numberOfLines={1}>
                    {retailer.toUpperCase()}
                  </Text>
                ) : null}
                <Text style={styles.name} numberOfLines={2}>
                  {productTitle}
                </Text>
                {priceText ? (
                  <Text style={styles.price} numberOfLines={1}>
                    {priceText}
                  </Text>
                ) : null}
                {isOutOfStock ? (
                  <Text style={styles.availabilityLabel} numberOfLines={1}>
                    Out of stock
                  </Text>
                ) : null}
                {/*
                    VTO seam: additive only. TryItOnEntry renders nothing
                    unless the item is genuinely eligible (or the only gap is
                    K+), so a card whose item cannot be tried on looks exactly
                    as it does today. Shopping authority is unchanged -- "Shop"
                    reuses this card's existing destination.
                */}
                {VTO_UI_ENABLED && vtoGarment ? (
                  <TryItOnEntry
                    garment={vtoGarment}
                    garmentTitle={productTitle}
                    origin="commerce_product"
                    onShop={hasLink ? () => handleLinkPress(purchaseUrl) : undefined}
                    testID={`try-it-on-${productKey}`}
                  />
                ) : null}
                {dressingRoomsEnabled ? (
                  /*
                    The label tracks the VISIBLE text. This control is not
                    disabled when an item can't be saved — it still opens the
                    sheet, which explains why — so it must not announce a
                    disabled state it does not have, and it must not promise
                    "Add to Dressing Room" while reading "Can't Save Yet".
                  */
                  <TouchableOpacity
                    testID="add-to-dressing-room-button"
                    accessibilityRole="button"
                    accessibilityLabel={
                      canSaveToRoom ? 'Add to Dressing Room' : "Can't save to a Dressing Room yet"
                    }
                    accessibilityHint={
                      canSaveToRoom
                        ? 'Choose a Dressing Room to save this item to'
                        : 'Explains why this item cannot be saved yet'
                    }
                    style={[
                      styles.addToRoomButton,
                      !canSaveToRoom ? styles.addToRoomButtonDisabled : null,
                    ]}
                    onPress={() => {
                      selectionTick();
                      setSelectedProduct(p);
                    }}
                    activeOpacity={0.82}
                  >
                    <Text style={styles.addToRoomText} numberOfLines={2} ellipsizeMode="tail">
                      {canSaveToRoom ? 'Add to Dressing Room' : "Can't Save Yet"}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {canWatch ? (
                  <KPlusGate source="watchlist">
                    {({ isActive, openUpgrade }) => (
                      <TouchableOpacity
                        testID="watch-listing-button"
                        accessibilityRole="button"
                        accessibilityLabel="Watch this listing"
                        accessibilityHint="Get notified about price changes on this item"
                        style={styles.addToRoomButton}
                        onPress={() => {
                          selectionTick();
                          if (isActive) setWatchModalProduct(p);
                          else openUpgrade();
                        }}
                        activeOpacity={0.82}
                      >
                        <Text style={styles.addToRoomText} numberOfLines={2} ellipsizeMode="tail">
                          Watch
                        </Text>
                      </TouchableOpacity>
                    )}
                  </KPlusGate>
                ) : null}
              </View>

              {hasLink && (
                <View style={styles.linkDot} accessibilityLabel="Has product link" />
              )}

            </View>
          );
        })}
      </ScrollView>

      {linkErrorVisible && (
        <Text style={styles.linkError}>LINK UNAVAILABLE</Text>
      )}

      {dressingRoomsEnabled ? (
        <AddToRoomModal
          product={selectedProduct}
          visible={!!selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      ) : null}

      <WatchThisModal
        product={watchModalProduct}
        visible={!!watchModalProduct}
        onClose={() => setWatchModalProduct(null)}
      />
    </View>
  );
}

export function AddToRoomModal({
  product,
  visible,
  onClose,
}: {
  product: Product | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { user } = useAuthSession();
  const { rooms, loading, error, reload } = useDressingRooms();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newRoomTitle, setNewRoomTitle] = useState('');

  const handleAdd = async (roomId: string) => {
    if (!product || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await addProductToDressingRoom(roomId, normalizeForSnapshot(product));
      const roomName = rooms.find((room) => room.id === roomId)?.title || 'Dressing Room';
      setMessage(`Saved to ${roomName}. You can revisit it from Dressing Rooms.`);
      setTimeout(onClose, 900);
    } catch (err: any) {
      setMessage(
        err instanceof UnsupportedStyleObjectItemError
          ? "This catalog item can't be added to a Dressing Room yet."
          : err?.message || 'Unable to add item.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAndAdd = async () => {
    if (!newRoomTitle.trim() || !product || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const room = await createDressingRoom({
        userId: user?.id,
        title: newRoomTitle,
        description: null,
      });
      await addProductToDressingRoom(room.id, normalizeForSnapshot(product));
      setNewRoomTitle('');
      setMessage(`Saved to ${room.title}. You can revisit it from Dressing Rooms.`);
      await reload();
      setTimeout(onClose, 900);
    } catch (err: any) {
      setMessage(err?.message || 'Unable to create Dressing Room.');
    } finally {
      setSaving(false);
    }
  };

  const unsupported = product ? !canAddProductToDressingRoom(product) : false;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        {/*
          accessibilityViewIsModal keeps VoiceOver inside the card while it is
          open instead of letting focus wander into the shelf behind it. On this
          platform it is the load-bearing half of the modal contract. No
          programmatic focus is moved: nothing here proved it was needed, and
          forcing focus is the brittle part of modal a11y.
        */}
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} accessibilityRole="header">
            Add to Dressing Room
          </Text>
          <Text style={styles.modalItemName} numberOfLines={2}>
            {getProductTitle(product) || 'Catalog item'}
          </Text>

          {unsupported ? (
            <Text style={styles.modalMessage}>This item can't be saved to a Dressing Room yet.</Text>
          ) : loading ? (
            <View style={styles.modalLoading}>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.modalMessage}>Loading Dressing Rooms...</Text>
            </View>
          ) : error ? (
            <Text style={styles.modalMessage}>{error}</Text>
          ) : (
            <>
              <ScrollView style={styles.roomList} contentContainerStyle={styles.roomListContent}>
                {rooms.length === 0 ? (
                  <View style={styles.modalEmptyState}>
                    <Text style={styles.modalMessage}>No Dressing Rooms yet.</Text>
                    <Text style={styles.modalSubMessage}>
                      Create one below to save this item and revisit it later.
                    </Text>
                  </View>
                ) : (
                  rooms.map((room) => (
                    <TouchableOpacity
                      key={room.id}
                      style={styles.roomChoice}
                      onPress={() => handleAdd(room.id)}
                      disabled={saving}
                      accessibilityRole="button"
                      accessibilityLabel={`${room.title}, ${room.itemCount ?? 0} items`}
                      accessibilityHint="Saves this item to that Dressing Room"
                      accessibilityState={{ disabled: saving }}
                      testID={`add-to-room-choice-${room.id}`}
                    >
                      <Text style={styles.roomChoiceTitle}>{room.title}</Text>
                      <Text style={styles.roomChoiceMeta}>{room.itemCount ?? 0} ITEMS</Text>
                      {saving ? <ActivityIndicator color={COLORS.accent} /> : null}
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>

              <View style={styles.quickCreate}>
                <Text style={styles.quickCreateLabel}>NEW ROOM</Text>
                <TextInput
                  value={newRoomTitle}
                  onChangeText={setNewRoomTitle}
                  placeholder="Vacation Capsule"
                  placeholderTextColor={COLORS.editorialTextMuted}
                  style={styles.quickCreateInput}
                />
              </View>
            </>
          )}

          {!unsupported ? (
            <View style={styles.newRoomControls}>
              <TouchableOpacity
                style={[styles.modalPrimaryButton, (!newRoomTitle.trim() || saving) && styles.modalButtonDisabled]}
                onPress={handleCreateAndAdd}
                disabled={!newRoomTitle.trim() || saving}
                accessibilityRole="button"
                accessibilityLabel="Create Dressing Room and add this item"
                accessibilityState={{ disabled: !newRoomTitle.trim() || saving, busy: saving }}
                testID="add-to-room-create"
              >
                {saving ? (
                  <ActivityIndicator color={COLORS.textInverse} />
                ) : (
                  <Text style={styles.modalPrimaryText}>CREATE + ADD</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {message ? <Text style={styles.modalMessage}>{message}</Text> : null}
          <TouchableOpacity
            style={styles.modalSecondaryButton}
            onPress={onClose}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Close"
            accessibilityHint="Closes without saving to a Dressing Room"
            accessibilityState={{ disabled: saving }}
            testID="add-to-room-close"
          >
            <Text style={styles.modalSecondaryText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/**
 * K5-C5: minimal Watch-intent picker. Reachable only for a listing already
 * marked `watchCapability === 'refreshable_listing'` server-side (§45) --
 * this modal re-derives nothing about eligibility, it only collects intent.
 * "Buy under $___" is the one threshold the user supplies (§25); the server
 * still refuses to arm it without a confident currency read.
 */
export function WatchThisModal({
  product,
  visible,
  onClose,
}: {
  product: Product | null;
  visible: boolean;
  onClose: () => void;
}) {
  const [intent, setIntent] = useState<WatchIntent>('just_watching');
  const [targetText, setTargetText] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleClose = () => {
    setIntent('just_watching');
    setTargetText('');
    setMessage(null);
    onClose();
  };

  const handleSave = async () => {
    if (!product || saving) return;
    const targetPriceAmount =
      intent === 'buy_under' ? Number(targetText.replace(/[^0-9.]/g, '')) : undefined;
    if (intent === 'buy_under' && (!targetPriceAmount || !Number.isFinite(targetPriceAmount) || targetPriceAmount <= 0)) {
      setMessage('Enter a target price to watch for.');
      return;
    }
    setSaving(true);
    setMessage(null);
    // Section 22: creating a Watch is a real, deterministic K+ feature
    // operation. Instrumentation only.
    emitKPlusEvent('kplus_feature_started', { source: 'watchlist', feature: 'watchlist' });
    const purchaseUrl = getPurchaseUrl(product);
    const result = await createWatch({
      listing: {
        productUrl: purchaseUrl || '',
        title: getProductTitle(product),
        price: product.price != null ? String(product.price) : undefined,
        source: getRetailer(product) || product.source || '',
        imageUrl: getProductImageUrl(product) || undefined,
        type: product.type ?? 'retail',
        commerceType: product.commerceType,
        watchCapability: product.watchCapability,
      },
      watchIntent: intent,
      targetPriceAmount,
    });
    setSaving(false);
    if (result.ok) {
      emitKPlusEvent('kplus_feature_completed', { source: 'watchlist', feature: 'watchlist' });
      setMessage("You're watching this listing.");
      const createdWatchId = result.data.id;
      setTimeout(handleClose, 900);
      // §51-52: notification permission is requested contextually, ONLY
      // here (a target price was just set) -- never at onboarding, K+
      // activation, or Watchlist open. A "not now" leaves the Watch valid
      // with push disabled; this never blocks or reverses the Watch itself.
      if (intent === 'buy_under') {
        setTimeout(() => {
          Alert.alert(
            'Alert me?',
            `Want K Scan AI to alert you when this listing reaches your target price?`,
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Alert me',
                // DEF-WL-06: the outcome is reported, not discarded. Arming
                // alerts can fail after the OS permission is granted (no push
                // token available on this build, registration rejected, no
                // network); firing this and ignoring the result left the user
                // believing an alert was armed when push_enabled stayed false.
                onPress: () => {
                  void (async () => {
                    const alerts = await requestWatchAlerts(createdWatchId);
                    if (alerts.ok) return;
                    const denied = 'reason' in alerts && alerts.reason === 'permission_denied';
                    Alert.alert(
                      denied ? 'Notifications are off' : "Couldn't turn on alerts",
                      denied
                        ? "We won't send alerts for this Watch. You can still check the price any time in your Watchlist."
                        : "We're still watching this listing, but we can't alert you on this device yet. Check the price any time in your Watchlist.",
                      [{ text: 'OK' }],
                    );
                  })();
                },
              },
            ],
          );
        }, 950);
      }
    } else {
      setMessage(
        'reason' in result && result.reason === 'kplus_required'
          ? 'K+ is required to create a Watch.'
          : "Couldn't create this Watch. Try again.",
      );
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} accessibilityRole="header">
            Watch this listing
          </Text>
          <Text style={styles.modalItemName} numberOfLines={2}>
            {getProductTitle(product) || 'Catalog item'}
          </Text>

          <TouchableOpacity
            testID="watch-intent-just-watching"
            style={styles.roomChoice}
            onPress={() => setIntent('just_watching')}
            accessibilityRole="radio"
            accessibilityState={{ selected: intent === 'just_watching' }}
          >
            <Text style={styles.roomChoiceTitle}>{intent === 'just_watching' ? '● ' : '○ '}Just watching</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="watch-intent-buy-under"
            style={styles.roomChoice}
            onPress={() => setIntent('buy_under')}
            accessibilityRole="radio"
            accessibilityState={{ selected: intent === 'buy_under' }}
          >
            <Text style={styles.roomChoiceTitle}>{intent === 'buy_under' ? '● ' : '○ '}Buy under a price</Text>
          </TouchableOpacity>

          {intent === 'buy_under' ? (
            <View style={styles.quickCreate}>
              <Text style={styles.quickCreateLabel}>TARGET PRICE</Text>
              <TextInput
                testID="watch-target-price-input"
                style={styles.quickCreateInput}
                placeholder="150"
                placeholderTextColor={COLORS.editorialTextMuted}
                keyboardType="decimal-pad"
                value={targetText}
                onChangeText={setTargetText}
                accessibilityLabel="Target price"
              />
            </View>
          ) : null}

          {message ? <Text style={styles.modalMessage}>{message}</Text> : null}

          <View style={styles.newRoomControls}>
            <TouchableOpacity
              testID="watch-save-button"
              style={[styles.modalPrimaryButton, saving && styles.modalButtonDisabled]}
              onPress={handleSave}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Start watching"
              accessibilityState={{ disabled: saving, busy: saving }}
            >
              {saving ? <ActivityIndicator color={COLORS.textInverse} /> : <Text style={styles.modalPrimaryText}>WATCH</Text>}
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            testID="watch-cancel-button"
            style={styles.modalSecondaryButton}
            onPress={handleClose}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.modalSecondaryText}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.xl,
  },
  emptyShelf: {
    marginTop: SPACING.xl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.lg,
    alignItems: 'center',
  },
  emptyShelfTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  emptyShelfBody: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'center',
    marginTop: SPACING.sm,
    lineHeight: 18,
    textTransform: 'none',
  },
  retryText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    textAlign: 'center',
    marginTop: SPACING.md,
    textDecorationLine: 'underline',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           SPACING.sm,
    marginBottom:  SPACING.md,
  },
  label: {
    ...LUXURY.typography.sectionLabel,
  },
  labelLine: {
    flex:            1,
    height:          1,
    backgroundColor: LUXURY.colors.border,
  },
  scrollContent: {
    gap:            SPACING.md,
    paddingBottom:  SPACING.xs,
  },
  card: {
    width:           CARD_WIDTH,
    borderRadius:    RADIUS.lg,
    borderWidth:     1,
    borderColor:     LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow:        'hidden',
    ...SHADOWS.editorialSmall,
  },
  cardNoLink: {
    opacity: 1,
  },
  image: {
    width:  IMAGE_SIZE,
    height: IMAGE_SIZE,
  },
  productImage: {
    width:  IMAGE_SIZE,
    height: IMAGE_SIZE,
    position: 'absolute',
    top: 0,
    left: 0,
  },
  imagePlaceholder: {
    backgroundColor: LUXURY.colors.champagne,
    alignItems:      'center',
    justifyContent:  'center',
    gap:             SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  imageSkeleton: {
    backgroundColor: LUXURY.colors.champagne,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  placeholderMark: {
    width:          72,
    height:         72,
    alignItems:     'center',
    justifyContent: 'center',
  },
  placeholderStroke: {
    borderWidth:     1,
    borderColor:     COLORS.arPurple,
  },
  placeholderGoldStroke: {
    borderWidth: 1,
    borderColor: COLORS.gold,
  },
  placeholderCyanStroke: {
    borderWidth: 1,
    borderColor: COLORS.arBlue,
  },
  placeholderCyanFill: {
    backgroundColor: COLORS.arBlue,
  },
  placeholderLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 9,
    letterSpacing: 1.1,
    maxWidth: IMAGE_SIZE - SPACING.lg,
    textAlign: 'center',
  },
  footwearUpper: {
    position:     'absolute',
    left:         11,
    top:          31,
    width:        41,
    height:       18,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 7,
    borderBottomWidth: 0,
  },
  footwearSole: {
    position:     'absolute',
    left:         8,
    top:          48,
    width:        55,
    height:       7,
    borderRadius: 7,
  },
  footwearHeel: {
    position: 'absolute',
    left:     13,
    top:      43,
    width:    7,
    height:   7,
  },
  outerwearBody: {
    position: 'absolute',
    top:      16,
    width:    34,
    height:   46,
    borderRadius: 5,
  },
  outerwearLapels: {
    position: 'absolute',
    top:      16,
    width:    16,
    height:   26,
    borderTopWidth: 0,
    borderLeftWidth: 0,
    borderRightWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  outerwearSleeveLeft: {
    position: 'absolute',
    left:     10,
    top:      22,
    width:    12,
    height:   34,
    borderRadius: 6,
  },
  outerwearSleeveRight: {
    position: 'absolute',
    right:    10,
    top:      22,
    width:    12,
    height:   34,
    borderRadius: 6,
  },
  topsBody: {
    position: 'absolute',
    top:      22,
    width:    36,
    height:   36,
    borderRadius: 6,
  },
  topsCollar: {
    position: 'absolute',
    top:      17,
    width:    18,
    height:   12,
    borderBottomWidth: 0,
    borderRadius: 9,
  },
  topsSleeveLeft: {
    position: 'absolute',
    left:     8,
    top:      25,
    width:    16,
    height:   16,
    borderRadius: 5,
  },
  topsSleeveRight: {
    position: 'absolute',
    right:    8,
    top:      25,
    width:    16,
    height:   16,
    borderRadius: 5,
  },
  bottomsWaist: {
    position: 'absolute',
    top:      16,
    width:    36,
    height:   8,
    borderRadius: 4,
  },
  bottomsLegLeft: {
    position: 'absolute',
    left:     19,
    top:      24,
    width:    15,
    height:   40,
    borderRadius: 4,
  },
  bottomsLegRight: {
    position: 'absolute',
    right:    19,
    top:      24,
    width:    15,
    height:   40,
    borderRadius: 4,
  },
  dressBodice: {
    position: 'absolute',
    top:      13,
    width:    20,
    height:   20,
    borderRadius: 5,
  },
  dressSkirt: {
    position: 'absolute',
    top:      31,
    width:    46,
    height:   32,
    borderTopWidth: 0,
    borderRadius: 6,
    transform: [{ perspective: 80 }, { rotateX: '14deg' }],
  },
  dressHem: {
    position: 'absolute',
    top:      60,
    width:    46,
    height:   1,
  },
  accessoryBody: {
    position: 'absolute',
    top:      28,
    width:    42,
    height:   31,
    borderRadius: 6,
  },
  accessoryHandle: {
    position: 'absolute',
    top:      16,
    width:    24,
    height:   22,
    borderBottomWidth: 0,
    borderRadius: 12,
  },
  accessoryClasp: {
    position: 'absolute',
    top:      39,
    width:    5,
    height:   5,
    borderRadius: 3,
  },
  cardBody: {
    padding: SPACING.sm,
    gap:     SPACING.xxs,
  },
  retailer: {
    ...LUXURY.typography.caption,
    fontSize:      10,
    letterSpacing: 1.4,
    color:         LUXURY.colors.stone,
    textTransform: 'uppercase' as const,
  },
  name: {
    ...LUXURY.typography.bodyStrong,
    fontSize:   13,
    lineHeight: 18,
  },
  price: {
    ...LUXURY.typography.bodyStrong,
    color:      LUXURY.colors.plum,
    marginTop:  SPACING.xxs,
  },
  availabilityLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xxs,
  },
  linkDot: {
    position:        'absolute',
    top:             SPACING.xs,
    right:           SPACING.xs,
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: COLORS.gold,
    opacity:         0.7,
  },
  linkError: {
    ...TYPOGRAPHY.caption,
    color:     COLORS.errorSoft,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  addToRoomButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumMuted,
    backgroundColor: LUXURY.colors.plumMuted,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  addToRoomButtonDisabled: {
    opacity: 0.5,
  },
  addToRoomText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 11,
    letterSpacing: 0.8,
    textAlign: 'center',
    textTransform: 'none',
    flexShrink: 1,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    maxHeight: '82%',
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
  },
  modalTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 22,
  },
  modalItemName: {
    ...LUXURY.typography.body,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  roomList: {
    maxHeight: 260,
  },
  roomListContent: {
    gap: SPACING.sm,
  },
  modalLoading: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.lg,
  },
  modalEmptyState: {
    paddingVertical: SPACING.md,
  },
  roomChoice: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  roomChoiceTitle: {
    ...LUXURY.typography.bodyStrong,
  },
  roomChoiceMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldText,
  },
  quickCreate: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  quickCreateLabel: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 11,
  },
  quickCreateInput: {
    minHeight: LUXURY.inputs.field.height,
    borderRadius: LUXURY.inputs.field.borderRadius,
    borderWidth: LUXURY.inputs.field.borderWidth,
    borderColor: LUXURY.inputs.field.borderColor,
    backgroundColor: LUXURY.colors.cream,
    color: LUXURY.inputs.field.color,
    paddingHorizontal: LUXURY.inputs.field.paddingHorizontal,
    paddingVertical: SPACING.sm,
    fontSize: LUXURY.inputs.field.fontSize,
  },
  newRoomControls: {
    marginTop: SPACING.md,
  },
  modalPrimaryButton: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  modalPrimaryText: {
    ...LUXURY.typography.cta,
  },
  modalSecondaryButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.md,
  },
  modalSecondaryText: {
    ...LUXURY.typography.ctaSecondary,
  },
  modalButtonDisabled: {
    opacity: 0.48,
  },
  modalMessage: {
    ...LUXURY.typography.bodyStrong,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
  modalSubMessage: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'center',
    marginTop: SPACING.sm,
    lineHeight: 18,
    textTransform: 'none',
  },
});
