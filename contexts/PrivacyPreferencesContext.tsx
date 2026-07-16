import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildPrivacyUpdatePatch,
  mergeNeedsWrite,
  mergePrivacyPreferences,
  normalizePrivacySettings,
} from '../services/privacyPolicy';
import { readPrivacyLocal, writePrivacyLocal } from '../services/privacyLocalStore';
import {
  ensurePrivacySettings,
  fetchProfile,
  isSupabaseProjectConfigured,
  updatePrivacySettings,
} from '../services/supabasePrivacy';
import { useAuthSession } from './AuthSessionContext';

const DEFAULT_PROFILE = {
  age_group: 'unknown',
  account_status: 'active' as const,
  account_locked_at: null as string | null,
};

type BootStatus = 'loading' | 'ready';

/** The overall privacy persistence mode. */
export type PrivacyMode = 'booting' | 'local' | 'remote-authenticated';

/**
 * Truthful sync status exposed to the UI.
 * - synced       → preference is saved to the user's account
 * - syncing      → a remote read or write is in flight
 * - local-only   → no authenticated session; preference saved on device only
 * - error        → remote sync failed; showing last-known device preference
 */
export type SyncStatus = 'synced' | 'syncing' | 'local-only' | 'error';

export type PrivacyPreferenceSource = 'remote' | 'local';

export interface PrivacyPreferencesContextValue {
  mode: PrivacyMode;
  syncStatus: SyncStatus;
  /** @deprecated Use `mode` instead. Kept for backward compatibility. */
  bootStatus: BootStatus;
  /** True when the user has an authenticated Supabase session. */
  remoteSessionActive: boolean;
  /** True when Supabase URL + anon key are configured (project is reachable). */
  supabaseProjectPresent: boolean;
  remoteFetchFailed: boolean;
  remoteFetchError: string | null;
  preferenceSource: PrivacyPreferenceSource;
  normalized: ReturnType<typeof normalizePrivacySettings>;
  profile: { age_group: string; account_status?: string; account_locked_at?: string | null };
  saving: boolean;
  refresh: () => Promise<void>;
  persistPreference: (patch: {
    opt_out_of_sale?: boolean;
    limit_sensitive_processing?: boolean;
  }) => Promise<void>;
}

const PrivacyPreferencesContext = createContext<PrivacyPreferencesContextValue | null>(null);

function buildSettingsFromRemote(
  remote: Record<string, unknown> | null,
  local: { opt_out_of_sale: boolean; limit_sensitive_processing: boolean },
) {
  if (remote) return remote;
  return {
    user_id: null,
    opt_out_of_sale: local.opt_out_of_sale,
    limit_sensitive_processing: local.limit_sensitive_processing,
    gdpr_consent_given: null,
    gdpr_consent_timestamp: null,
    gdpr_consent_version: null,
    consent_version: 'ccpa_cpra_mobile_v1',
    last_request_source: null,
    last_processed_at: null,
    updated_at: null,
  };
}

export function PrivacyPreferencesProvider({ children }: { children: React.ReactNode }) {
  const { session, isAuthenticated, isRefreshing, loading: authLoading } = useAuthSession();

  const [bootStatus, setBootStatus] = useState<BootStatus>('loading');
  const [remoteRow, setRemoteRow] = useState<Record<string, unknown> | null>(null);
  const [profile, setProfile] = useState<{
    age_group: string;
    account_status?: string;
    account_locked_at?: string | null;
  }>(DEFAULT_PROFILE);
  const [localPrefs, setLocalPrefs] = useState({ opt_out_of_sale: false, limit_sensitive_processing: false });
  const [remoteFetchFailed, setRemoteFetchFailed] = useState(false);
  const [remoteFetchError, setRemoteFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');

  const supabaseProjectPresent = isSupabaseProjectConfigured();

  // Derive mode from auth state
  const mode: PrivacyMode = authLoading
    ? 'booting'
    : isAuthenticated
    ? 'remote-authenticated'
    : 'local';

  // remoteSessionActive kept for backward compat — maps to isAuthenticated
  const remoteSessionActive = isAuthenticated;

  const preferenceSource: PrivacyPreferenceSource =
    isAuthenticated && remoteRow != null && !remoteFetchFailed ? 'remote' : 'local';

  const normalized = useMemo(
    () => normalizePrivacySettings(buildSettingsFromRemote(remoteRow, localPrefs), profile),
    [remoteRow, localPrefs, profile],
  );

  // Stable snapshot ref so persistPreference always sees fresh state
  const snapshotRef = useRef({ remoteRow, localPrefs, profile, normalized, remoteFetchFailed });
  snapshotRef.current = { remoteRow, localPrefs, profile, normalized, remoteFetchFailed };

  // Auth state ref for hydrate to read without re-creating the callback
  const authRef = useRef({ isAuthenticated, isRefreshing, authLoading });
  authRef.current = { isAuthenticated, isRefreshing, authLoading };
  const bootStatusRef = useRef(bootStatus);
  bootStatusRef.current = bootStatus;
  const hydrateGenerationRef = useRef(0);

  const hydrate = useCallback(async (options?: { gateRouting?: boolean }) => {
    const auth = authRef.current;

    // Still booting: don't render any mode yet; the layout gates children behind loading state
    if (auth.authLoading) return;

    const generation = hydrateGenerationRef.current + 1;
    hydrateGenerationRef.current = generation;

    // Only block AuthGate routing on first boot or actor change. Same-actor
    // revalidation (and especially access-token refresh) must not flip
    // bootStatus back to loading — that unmounts the root navigator and aborts
    // in-flight auth/network work.
    const gateRouting = Boolean(options?.gateRouting) || bootStatusRef.current !== 'ready';
    if (gateRouting) {
      setBootStatus('loading');
    }
    setRemoteFetchFailed(false);
    setRemoteFetchError(null);
    setSyncStatus('syncing');

    let local = { opt_out_of_sale: false, limit_sensitive_processing: false };
    try {
      local = await readPrivacyLocal();
    } catch {
      // keep defaults
    }
    if (hydrateGenerationRef.current !== generation) return;
    setLocalPrefs(local);

    if (auth.isAuthenticated && !auth.isRefreshing) {
      try {
        // ensurePrivacySettings is load-bearing — failure means remote mode is unavailable.
        // fetchProfile is best-effort: a missing `profiles` table must not block privacy loading.
        const settingsRow = await ensurePrivacySettings();
        let profileRow: Record<string, unknown> = DEFAULT_PROFILE;
        try {
          const fetched = await fetchProfile();
          if (fetched && typeof fetched === 'object' && 'age_group' in fetched) {
            profileRow = fetched as Record<string, unknown>;
          }
        } catch {
          // profiles table absent or RLS gap — proceed with default profile
        }

        if (hydrateGenerationRef.current !== generation) return;

        const remote = (settingsRow ?? null) as Record<string, unknown> | null;

        if (remote) {
          const remotePrefs = {
            opt_out_of_sale: Boolean(remote.opt_out_of_sale),
            limit_sensitive_processing: Boolean(remote.limit_sensitive_processing),
          };

          // Merge: local ON propagates to remote if remote is OFF
          if (mergeNeedsWrite(local, remotePrefs)) {
            const merged = mergePrivacyPreferences(local, remotePrefs);
            const patch = buildPrivacyUpdatePatch(merged, profileRow);
            try {
              const updated = await updatePrivacySettings(patch);
              if (hydrateGenerationRef.current !== generation) return;
              setRemoteRow((updated ?? { ...remote, ...patch }) as Record<string, unknown>);
            } catch {
              if (hydrateGenerationRef.current !== generation) return;
              // Merge write failed; reflect merged value locally without remote confirmation
              setRemoteRow({ ...remote, ...mergePrivacyPreferences(local, remotePrefs) } as Record<string, unknown>);
            }
          } else {
            setRemoteRow(remote);
          }
        } else {
          setRemoteRow(null);
        }

        setProfile({
          age_group: String((profileRow as { age_group?: string }).age_group || 'unknown'),
          account_status: (profileRow as { account_status?: string }).account_status,
          account_locked_at: (profileRow as { account_locked_at?: string | null }).account_locked_at ?? null,
        });
        setSyncStatus('synced');
      } catch (error) {
        if (hydrateGenerationRef.current !== generation) return;
        setRemoteRow(null);
        setRemoteFetchFailed(true);
        setRemoteFetchError('Unable to load privacy settings. Please try again later.');
        setProfile(DEFAULT_PROFILE);
        setSyncStatus('error');
      }
    } else if (!auth.isAuthenticated) {
      // Signed out only — do not clear remote rows while a refresh is in flight.
      setRemoteRow(null);
      setSyncStatus('local-only');
    }

    if (hydrateGenerationRef.current !== generation) return;
    setBootStatus('ready');
  }, []); // auth state read from ref — no dep cycle

  // Re-hydrate on actor transitions (sign-in / sign-out / cold boot), not on
  // every access_token rotation. Token refresh must not re-gate routing.
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const userId = session?.user?.id ?? null;

    // Skip the very first render before auth has settled
    if (authLoading) return;

    // On sign-out: clear remote data immediately without a full hydrate
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== null && userId === null) {
      hydrateGenerationRef.current += 1;
      prevUserIdRef.current = userId;
      setRemoteRow(null);
      setRemoteFetchFailed(false);
      setRemoteFetchError(null);
      setProfile(DEFAULT_PROFILE);
      setSyncStatus('local-only');
      setBootStatus('ready');
      return;
    }

    const actorChanged = prevUserIdRef.current !== userId;
    prevUserIdRef.current = userId;
    void hydrate({ gateRouting: actorChanged || bootStatusRef.current !== 'ready' });
  }, [session?.user?.id, authLoading, hydrate]);

  const persistPreference = useCallback(
    async (patch: { opt_out_of_sale?: boolean; limit_sensitive_processing?: boolean }) => {
      const snap = snapshotRef.current;
      const auth = authRef.current;

      // Block writes during auth boot or token refresh to avoid stale-token errors
      if (auth.authLoading || auth.isRefreshing) {
        throw new Error('Session is refreshing. Please try again in a moment.');
      }

      setSaving(true);
      setSyncStatus('syncing');
      try {
        const canWriteRemote =
          auth.isAuthenticated && snap.remoteRow != null && !snap.remoteFetchFailed;

        if (canWriteRemote) {
          const merged = { ...snap.normalized, ...patch };
          const body = buildPrivacyUpdatePatch(merged, snap.profile);
          const updated = await updatePrivacySettings(body);
          setRemoteRow((updated ?? { ...snap.remoteRow, ...body }) as Record<string, unknown>);
          setRemoteFetchFailed(false);
          setRemoteFetchError(null);
          setSyncStatus('synced');
        } else {
          const written = await writePrivacyLocal(patch);
          setLocalPrefs({
            opt_out_of_sale: written.opt_out_of_sale,
            limit_sensitive_processing: written.limit_sensitive_processing,
          });
          setSyncStatus(auth.isAuthenticated ? 'error' : 'local-only');
        }
      } catch (error) {
        setSyncStatus(auth.isAuthenticated ? 'error' : 'local-only');
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const value = useMemo<PrivacyPreferencesContextValue>(
    () => ({
      mode,
      syncStatus,
      bootStatus,
      remoteSessionActive,
      supabaseProjectPresent,
      remoteFetchFailed,
      remoteFetchError,
      preferenceSource,
      normalized,
      profile,
      saving,
      refresh: hydrate,
      persistPreference,
    }),
    [
      mode,
      syncStatus,
      bootStatus,
      remoteSessionActive,
      supabaseProjectPresent,
      remoteFetchFailed,
      remoteFetchError,
      preferenceSource,
      normalized,
      profile,
      saving,
      hydrate,
      persistPreference,
    ],
  );

  return (
    <PrivacyPreferencesContext.Provider value={value}>
      {children}
    </PrivacyPreferencesContext.Provider>
  );
}

export function usePrivacyPreferences(): PrivacyPreferencesContextValue {
  const ctx = useContext(PrivacyPreferencesContext);
  if (!ctx) {
    throw new Error('usePrivacyPreferences must be used within PrivacyPreferencesProvider');
  }
  return ctx;
}
