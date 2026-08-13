/**
 * Self-service account restoration (`/account/restore`).
 *
 * Reached from the restoration email link built by
 * `buildRestorationUrl()` — `https://kscan.app/account/restore?token=…` — so the
 * path here must stay exactly `/account/restore`. It lives under the `(public)`
 * group, which is a routing group only and contributes nothing to the URL.
 *
 * The visitor is, by definition, unable to sign in: their account is in the
 * `deactivated` grace window. The screen therefore works with no session, and
 * `routingGuard` allows it both signed out (PUBLIC_ROUTES) and for a still-
 * signed-in deactivated account (LIMITED_ACCOUNT_ROUTES) — otherwise the
 * pending-deletion redirect would bounce that user to /privacy and the link
 * would be unusable for them.
 *
 * TOKEN HYGIENE: the token is read from route params into component state,
 * handed to `restoreAccountWithToken`, and then the route is replaced with a
 * token-free URL so it does not linger in navigation history. It is never
 * written to storage, logged, or included in any error surface.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  InlineNotice,
  KScanHeader,
  LuxuryScreen,
  PrimaryButton,
  SecondaryButton,
} from '../../../components/luxury';
import { LUXURY, SPACING } from '../../../constants/theme';
import { supabase } from '../../../services/supabaseClient';
import {
  extractRestorationToken,
  restoreAccountWithToken,
  type RestoreOutcome,
} from '../../../services/accountRestoration';

type ScreenState =
  | { phase: 'restoring' }
  | { phase: 'done'; outcome: RestoreOutcome; message: string };

export default function AccountRestoreScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const [state, setState] = useState<ScreenState>({ phase: 'restoring' });

  // Single-flight latch. A restoration token is single-use, so a re-render or a
  // param change must never fire a second consume attempt — the second would
  // always fail and would overwrite a genuine success with "link no longer
  // valid".
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    const token = extractRestorationToken(params?.token);
    if (!token) {
      setState({
        phase: 'done',
        outcome: 'invalid',
        message:
          'This restoration link is missing or malformed. You can request a new one below.',
      });
      return;
    }

    let cancelled = false;
    (async () => {
      const result = await restoreAccountWithToken(supabase, token);
      // Drop the token-bearing URL from history as soon as it has been used,
      // so backgrounding, a back gesture, or a screenshot of the URL cannot
      // replay it.
      try {
        router.replace('/account/restore');
      } catch {
        // Navigation is best-effort hygiene; never fail the restore over it.
      }
      if (!cancelled) {
        setState({ phase: 'done', outcome: result.outcome, message: result.message });
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally runs once: the latch above, not the dependency list, owns
    // single-flight, and `params.token` is deliberately cleared mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToSignIn = useCallback(() => {
    router.replace('/auth');
  }, []);

  const goToResend = useCallback(() => {
    router.replace('/auth?restore=1');
  }, []);

  return (
    <LuxuryScreen>
      <StatusBar style="dark" />
      <KScanHeader title="Restore Account" />
      <View style={styles.body}>
        {state.phase === 'restoring' ? (
          <View style={styles.center} testID="account-restore-loading">
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
            <Text style={styles.loadingText}>Restoring your account…</Text>
          </View>
        ) : (
          <>
            <InlineNotice
              testID="account-restore-result"
              accessibilityRole="alert"
              variant={
                state.outcome === 'restored'
                  ? 'success'
                  : state.outcome === 'pending_unban'
                    ? 'warning'
                    : 'error'
              }
              title={
                state.outcome === 'restored'
                  ? 'Account restored'
                  : state.outcome === 'pending_unban'
                    ? 'Almost there'
                    : 'Link not valid'
              }
              body={state.message}
            />

            {state.outcome === 'restored' || state.outcome === 'pending_unban' ? (
              <PrimaryButton
                title="Go to Sign In"
                onPress={goToSignIn}
                testID="account-restore-signin"
                accessibilityLabel="Go to sign in"
                style={styles.action}
              />
            ) : (
              <>
                <PrimaryButton
                  title="Request a New Link"
                  onPress={goToResend}
                  testID="account-restore-resend"
                  accessibilityLabel="Request a new restoration link"
                  style={styles.action}
                />
                <SecondaryButton
                  title="Back to Sign In"
                  onPress={goToSignIn}
                  testID="account-restore-back"
                  accessibilityLabel="Back to sign in"
                  style={styles.action}
                />
              </>
            )}
          </>
        )}
      </View>
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: SPACING.md,
    color: LUXURY.colors.plum,
    fontSize: 16,
  },
  action: {
    marginTop: SPACING.md,
  },
});
