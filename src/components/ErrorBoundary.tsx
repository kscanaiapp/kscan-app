import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { logError } from '../utils/errorLogger';

type ErrorBoundaryProps = React.PropsWithChildren;

type ErrorBoundaryState = {
  hasError: boolean;
  error?: Error;
  componentStack?: string;
  resetKey: number;
};

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);

    this.state = {
      hasError: false,
      error: undefined,
      componentStack: undefined,
      resetKey: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({
      componentStack: errorInfo.componentStack ?? undefined,
    });

    logError('Error Boundary caught render error', error, {
      componentStack: errorInfo.componentStack,
    });
  }

  reset = (): void => {
    this.setState((prevState) => ({
      hasError: false,
      error: undefined,
      componentStack: undefined,
      resetKey: prevState.resetKey + 1,
    }));
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <ScrollView
            testID="error-boundary-screen"
            contentContainerStyle={styles.container}
          >
            <Text style={styles.logo}>K SCAN AI</Text>
            <Text style={styles.title}>SOMETHING WENT WRONG</Text>
            <Text style={styles.message}>
              The scan session encountered an unexpected issue.
            </Text>
            <TouchableOpacity
              testID="error-boundary-retry"
              style={styles.button}
              onPress={this.reset}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.buttonText}>TRY AGAIN</Text>
            </TouchableOpacity>
            {__DEV__ && this.state.error ? (
              <View style={styles.devContainer}>
                <Text
                  testID="error-boundary-dev-message"
                  style={styles.devText}
                >
                  {this.state.error.message}
                </Text>
                {this.state.componentStack ? (
                  <Text style={styles.devStackText}>
                    {this.state.componentStack}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      );
    }

    return (
      // This remounts the whole app subtree; route-level boundaries can narrow recovery later.
      <React.Fragment key={this.state.resetKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#09090b',
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    backgroundColor: '#09090b',
  },
  logo: {
    color: '#f5f5f5',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: 20,
  },
  title: {
    color: '#f5f5f5',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 3,
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    color: '#a1a1aa',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 32,
  },
  button: {
    borderWidth: 1,
    borderColor: '#d4d4d8',
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#111827',
  },
  buttonText: {
    color: '#f5f5f5',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 2,
  },
  devContainer: {
    width: '100%',
    marginTop: 28,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#3f3f46',
    backgroundColor: '#111827',
  },
  devText: {
    color: '#fda4af',
    fontSize: 12,
    textAlign: 'center',
  },
  devStackText: {
    color: '#cbd5e1',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 12,
  },
});
