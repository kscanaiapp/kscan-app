// Receipt & Purchase Intelligence V1 — customer-safe error taxonomy.
//
// One registry, declared once (spec section 36). Nothing else in the feature
// may invent a class, and no raw provider message, status code, stack trace,
// provider name or internal id is ever shown in place of this copy.

export const PURCHASE_IMPORT_ERROR_CLASSES = [
  'invalid_file',
  'file_too_large',
  'unreadable_document',
  'no_fashion_purchases',
  'too_many_items',
  'network_unavailable',
  'provider_unavailable',
  'schema_validation_failed',
  'partial_closet_persistence',
  'unauthorized',
  'session_changed',
  'rate_limited',
  'feature_disabled',
] as const;
export type PurchaseImportErrorClass = typeof PURCHASE_IMPORT_ERROR_CLASSES[number];

export type PurchaseImportErrorPresentation = {
  title: string;
  message: string;
  /** Whether trying the same thing again can help. */
  retryable: boolean;
  /** What the primary recovery action does. */
  recovery: 'choose_another' | 'retry' | 'sign_in' | 'close';
};

export const PURCHASE_IMPORT_ERRORS: Readonly<Record<PurchaseImportErrorClass, PurchaseImportErrorPresentation>> =
  Object.freeze({
    invalid_file: {
      title: 'That file can’t be used',
      message: 'Choose a screenshot or photo of your order confirmation or receipt.',
      retryable: false,
      recovery: 'choose_another',
    },
    file_too_large: {
      title: 'This image is too large to process',
      message: 'Try cropping it to just the purchased items.',
      retryable: false,
      recovery: 'choose_another',
    },
    unreadable_document: {
      title: 'I couldn’t read this clearly',
      message: 'Try another photo or crop to the purchased items.',
      retryable: false,
      recovery: 'choose_another',
    },
    no_fashion_purchases: {
      title: 'No fashion purchases found',
      message: 'Nothing on this document looks like clothing, shoes, bags or accessories, so nothing was added.',
      retryable: false,
      recovery: 'choose_another',
    },
    too_many_items: {
      title: 'Too many items on one image',
      message: 'Crop to a smaller group of purchased items and import them in parts.',
      retryable: false,
      recovery: 'choose_another',
    },
    network_unavailable: {
      title: 'You’re offline',
      message: 'Reconnect and try again. Nothing was added to your Closet.',
      retryable: true,
      recovery: 'retry',
    },
    provider_unavailable: {
      title: 'Import is temporarily unavailable',
      message: 'Please try again in a moment. Nothing was added to your Closet.',
      retryable: true,
      recovery: 'retry',
    },
    schema_validation_failed: {
      title: 'Something went wrong reading this',
      message: 'Please try again. Nothing was added to your Closet.',
      retryable: true,
      recovery: 'retry',
    },
    partial_closet_persistence: {
      title: 'Some items weren’t added',
      message: 'The items marked below couldn’t be saved. Retrying won’t duplicate the ones that were added.',
      retryable: true,
      recovery: 'retry',
    },
    unauthorized: {
      title: 'Sign in to import purchases',
      message: 'Importing an order needs a signed-in K Scan account.',
      retryable: false,
      recovery: 'sign_in',
    },
    session_changed: {
      title: 'Your account changed',
      message: 'This import was cleared because a different account is now signed in. Nothing was added.',
      retryable: false,
      recovery: 'close',
    },
    rate_limited: {
      title: 'Please wait a moment',
      message: 'You’ve imported several orders in a short time. Try again shortly.',
      retryable: true,
      recovery: 'retry',
    },
    feature_disabled: {
      title: 'Order import isn’t available',
      message: 'This feature isn’t available right now.',
      retryable: false,
      recovery: 'close',
    },
  });

export function isPurchaseImportErrorClass(value: unknown): value is PurchaseImportErrorClass {
  return typeof value === 'string' && (PURCHASE_IMPORT_ERROR_CLASSES as readonly string[]).includes(value);
}

/** Server failure class -> client error class. Unknown values are a schema failure. */
export function fromServerErrorClass(value: unknown): PurchaseImportErrorClass {
  switch (value) {
    case 'invalid_file':
    case 'file_too_large':
    case 'unreadable_document':
    case 'too_many_items':
    case 'provider_unavailable':
    case 'schema_validation_failed':
    case 'unauthorized':
    case 'rate_limited':
    case 'feature_disabled':
      return value;
    default:
      return 'schema_validation_failed';
  }
}

/**
 * Transport failure -> client error class. Only the HTTP status and the typed
 * server class are read. The server message body is never read or displayed.
 */
export function classifyTransportFailure(input: {
  aborted?: boolean;
  offline?: boolean;
  httpStatus?: number | null;
  serverErrorClass?: unknown;
}): PurchaseImportErrorClass {
  if (input.offline) return 'network_unavailable';
  if (input.serverErrorClass !== undefined && input.serverErrorClass !== null) {
    return fromServerErrorClass(input.serverErrorClass);
  }
  const status = input.httpStatus ?? null;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 413) return 'file_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_file';
  if (input.aborted) return 'provider_unavailable';
  return 'provider_unavailable';
}
