import type {
  StylistAvatarPresetAbstract,
  StylistAvatarPresetPortraitPlaceholder,
  StylistAvatarPresetPortraitReady,
} from '../constants/stylistIdentity';

export const readyPortraitFixture: StylistAvatarPresetPortraitReady = {
  kind: 'portrait',
  availability: 'ready',
  id: 'test_ready_portrait',
  accessibilityLabel: 'Test ready portrait',
  source: 1,
  selectable: true,
  persistable: true,
};

// @ts-expect-error A ready portrait requires a static numeric source.
const readyPortraitWithoutSource: StylistAvatarPresetPortraitReady = {
  kind: 'portrait',
  availability: 'ready',
  id: 'missing_source',
  accessibilityLabel: 'Missing source',
  selectable: true,
  persistable: true,
};

const placeholderWithSource: StylistAvatarPresetPortraitPlaceholder = {
  kind: 'portrait',
  availability: 'placeholder',
  id: 'placeholder_with_source',
  accessibilityLabel: 'Invalid placeholder',
  // @ts-expect-error A placeholder cannot carry a source.
  source: 1,
  selectable: false,
  persistable: false,
};

const selectablePlaceholder: StylistAvatarPresetPortraitPlaceholder = {
  kind: 'portrait',
  availability: 'placeholder',
  id: 'selectable_placeholder',
  accessibilityLabel: 'Invalid placeholder',
  // @ts-expect-error A placeholder cannot be selectable.
  selectable: true,
  persistable: false,
};

const persistablePlaceholder: StylistAvatarPresetPortraitPlaceholder = {
  kind: 'portrait',
  availability: 'placeholder',
  id: 'persistable_placeholder',
  accessibilityLabel: 'Invalid placeholder',
  selectable: false,
  // @ts-expect-error A placeholder cannot be persistable.
  persistable: true,
};

const unavailableAbstract: StylistAvatarPresetAbstract = {
  kind: 'abstract',
  // @ts-expect-error Abstract presets are always ready.
  availability: 'placeholder',
  id: 'unavailable_abstract',
  accessibilityLabel: 'Invalid abstract',
  backgroundColor: '#000000',
  accentColor: '#FFFFFF',
  symbol: 'x',
  symbolColor: '#FFFFFF',
  selectable: true,
  persistable: true,
};

void readyPortraitWithoutSource;
void placeholderWithSource;
void selectablePlaceholder;
void persistablePlaceholder;
void unavailableAbstract;
