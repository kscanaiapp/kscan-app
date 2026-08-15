import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AI_OUTPUT_REPORT_REASONS,
  createAiOutputReportSubmissionGate,
  submitAiOutputReport,
  type AiOutputReportReasonId,
  type AiOutputReportRequest,
} from '../services/reportAiOutput';
import { isReportServerAccepted } from '../services/contentReports';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';

type AiOutputReportingContextValue = {
  openAiOutputReport: (request: AiOutputReportRequest) => void;
};

type ReportState = 'form' | 'submitting' | 'success' | 'error';

const AiOutputReportingContext = createContext<AiOutputReportingContextValue | null>(null);

export function useAiOutputReporting(): AiOutputReportingContextValue {
  const value = useContext(AiOutputReportingContext);
  if (!value) {
    throw new Error('useAiOutputReporting must be used inside AiOutputReportProvider.');
  }
  return value;
}

export function AiOutputReportProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<AiOutputReportRequest | null>(null);
  const [reasonId, setReasonId] = useState<AiOutputReportReasonId | null>(null);
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<ReportState>('form');
  const submissionGateRef = useRef(createAiOutputReportSubmissionGate());

  const close = useCallback(() => {
    if (state === 'submitting') return;
    setRequest(null);
    setReasonId(null);
    setNotes('');
    setState('form');
  }, [state]);

  const openAiOutputReport = useCallback((nextRequest: AiOutputReportRequest) => {
    setRequest(nextRequest);
    setReasonId(null);
    setNotes('');
    setState('form');
  }, []);

  const submit = useCallback(async () => {
    if (!request || !reasonId) return;

    setState('submitting');
    try {
      const attempt = await submissionGateRef.current.run(() =>
        submitAiOutputReport({ request, reasonId, notes }),
      );
      if (!attempt.started) return;

      // KSB29-035: `ok: true` is NOT server acceptance. It also covers the
      // local-only outcome ({ ok: true, serverAccepted: false, localOnly: true })
      // returned when there is no authenticated session — the row never reached
      // the server. Showing "REPORT SENT" there tells the user their report was
      // filed for review when nothing was submitted, which for a Play
      // submission requirement is the one failure mode that must not happen
      // silently. `isReportServerAccepted` is the single authoritative decision
      // point the Dressing Room report path already uses (DEF-B29-IOS-02C); a
      // duplicate still counts, because the original report is on file.
      setState(isReportServerAccepted(attempt.value) ? 'success' : 'error');
    } catch {
      setState('error');
    }
  }, [notes, reasonId, request]);

  const retry = useCallback(() => setState('form'), []);

  return (
    <AiOutputReportingContext.Provider value={{ openAiOutputReport }}>
      {children}
      <Modal
        animationType="fade"
        transparent
        visible={Boolean(request)}
        onRequestClose={close}
        statusBarTranslucent
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View
            style={styles.sheet}
            testID="ai-output-report-sheet"
            accessibilityViewIsModal
          >
            {state === 'success' ? (
              <View style={styles.resultContent} testID="ai-output-report-success" accessibilityLiveRegion="polite">
                <Text style={styles.eyebrow}>REPORT SENT</Text>
                <Text style={styles.title}>Thank you for helping keep K Scan safe.</Text>
                <Text style={styles.body}>
                  Your report has been received for review.
                </Text>
                <Pressable
                  onPress={close}
                  style={styles.primaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Done"
                  testID="ai-output-report-done"
                >
                  <Text style={styles.primaryButtonText}>Done</Text>
                </Pressable>
              </View>
            ) : state === 'error' ? (
              <View style={styles.resultContent} testID="ai-output-report-error" accessibilityLiveRegion="polite">
                <Text style={styles.eyebrow}>REPORT NOT SENT</Text>
                <Text style={styles.title}>We couldn&apos;t send your report.</Text>
                <Text style={styles.body}>
                  Your selected reason and optional note are still here. Please try again.
                </Text>
                <Pressable
                  onPress={retry}
                  style={styles.primaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Try submitting the report again"
                  testID="ai-output-report-retry"
                >
                  <Text style={styles.primaryButtonText}>Try again</Text>
                </Pressable>
                <Pressable
                  onPress={close}
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel reporting this response"
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
                <View style={styles.handle} />
                <Text style={styles.eyebrow}>REPORT RESPONSE</Text>
                <Text style={styles.title}>What&apos;s wrong with this AI response?</Text>
                <Text style={styles.body}>
                  Your report is sent to K Scan for review. Please avoid including private information.
                </Text>

                <View style={styles.reasonList} accessibilityRole="radiogroup">
                  {AI_OUTPUT_REPORT_REASONS.map((reason) => {
                    const selected = reason.id === reasonId;
                    return (
                      <Pressable
                        key={reason.id}
                        onPress={() => setReasonId(reason.id)}
                        style={[styles.reasonOption, selected ? styles.reasonOptionSelected : null]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={reason.label}
                        testID={`ai-output-report-reason-${reason.id}`}
                      >
                        <View style={[styles.radio, selected ? styles.radioSelected : null]}>
                          {selected ? <View style={styles.radioDot} /> : null}
                        </View>
                        <Text style={[styles.reasonText, selected ? styles.reasonTextSelected : null]}>
                          {reason.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  editable={state !== 'submitting'}
                  placeholder="Additional context (optional)"
                  placeholderTextColor={LUXURY.colors.stone}
                  maxLength={1000}
                  multiline
                  textAlignVertical="top"
                  style={styles.notesInput}
                  accessibilityLabel="Additional report context, optional"
                  testID="ai-output-report-notes"
                />

                <Pressable
                  onPress={submit}
                  disabled={!reasonId || state === 'submitting'}
                  style={[
                    styles.primaryButton,
                    (!reasonId || state === 'submitting') ? styles.primaryButtonDisabled : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !reasonId || state === 'submitting', busy: state === 'submitting' }}
                  accessibilityLabel="Submit AI response report"
                  testID="ai-output-report-submit"
                >
                  {state === 'submitting' ? (
                    <ActivityIndicator color={LUXURY.colors.inverse} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Submit report</Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={close}
                  disabled={state === 'submitting'}
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: state === 'submitting' }}
                  accessibilityLabel="Cancel reporting this response"
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </AiOutputReportingContext.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(13, 9, 20, 0.62)',
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  sheet: {
    maxHeight: '88%',
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    overflow: 'hidden',
    ...SHADOWS.editorialRaised,
  },
  formContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xl,
  },
  resultContent: {
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.border,
    marginBottom: SPACING.lg,
  },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.plum,
    marginBottom: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  body: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.sm,
  },
  reasonList: {
    gap: SPACING.sm,
    marginTop: SPACING.xl,
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.cream,
  },
  reasonOptionSelected: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.pearl,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.stone,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: LUXURY.colors.plum,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
  },
  reasonText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    flexShrink: 1,
  },
  reasonTextSelected: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
  },
  notesInput: {
    ...LUXURY.typography.body,
    minHeight: 104,
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    borderRadius: RADIUS.md,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.cream,
  },
  primaryButton: {
    minHeight: 52,
    marginTop: SPACING.lg,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.plum,
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  secondaryButton: {
    // The Cancel/dismiss control on the AI-report sheet. 44 met the iOS
    // minimum but not Android's 48; a single shared floor is simpler here and
    // costs no layout.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.xs,
  },
  secondaryButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
  },
});
