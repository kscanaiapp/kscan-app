/**
 * B35-SCAN-014: commercial results are attached to the garment the customer
 * actually selected, not to every detection candidate.
 *
 * Pure orchestration boundary; injectable transport lets tests exercise real
 * async ordering and actor/session invalidation without paid provider calls.
 * Image bytes never enter the commerce-only request.
 */
export async function hydrateSelectedBatchCommerce(item, {
  fetchCommerce,
  isCurrent,
  signal,
}) {
  const evidence = item?.analysis?.commerceEvidence;
  if (!item?.id || !item?.analysis?.commerceDeferred || !evidence?.identification) {
    return { status: 'not_required', item };
  }
  if (signal?.aborted || !isCurrent()) return { status: 'stale' };

  // Always bind MODE B to THIS selected candidate. Never reuse the prior
  // garment's identification, source photo or candidate id.
  const commerceEvidence = {
    identification: evidence.identification,
    attributes: evidence.attributes ?? null,
    candidateId: item.id,
  };
  let result;
  try {
    result = await fetchCommerce(commerceEvidence, { signal });
  } catch {
    result = { status: 'error', retryable: true };
  }
  if (signal?.aborted || !isCurrent()) return { status: 'stale' };

  // The backend may omit its optional echo (older deployed versions), but a
  // conflicting echo is NEVER allowed to hydrate this garment.
  if (result?.candidateId && result.candidateId !== item.id) {
    return { status: 'error', retryable: true };
  }
  if (result?.status !== 'success' && result?.status !== 'empty') {
    return { status: 'error', retryable: result?.retryable !== false };
  }

  const purchaseOptions = Array.isArray(result.purchaseOptions) ? result.purchaseOptions : [];
  return {
    status: result.status,
    retryable: result.retryable !== false,
    item: {
      ...item,
      analysis: {
        ...item.analysis,
        purchaseOptions,
      },
    },
  };
}
