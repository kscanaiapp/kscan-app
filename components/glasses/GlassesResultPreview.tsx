import React from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
} from 'react-native';
import type { GlassesMockResult } from '../../types/glasses';

interface GlassesResultPreviewProps {
  result: GlassesMockResult;
}

export function GlassesResultPreview({ result }: GlassesResultPreviewProps) {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>{result.title}</Text>
      <Text style={styles.summary}>{result.summary}</Text>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Category</Text>
        <Text style={styles.metaValue}>{result.category}</Text>
      </View>

      {result.color ? (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Color</Text>
          <Text style={styles.metaValue}>{result.color}</Text>
        </View>
      ) : null}

      {result.silhouette ? (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Silhouette</Text>
          <Text style={styles.metaValue}>{result.silhouette}</Text>
        </View>
      ) : null}

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Confidence</Text>
        <Text style={styles.metaValue}>
          {Math.round(result.confidence * 100)}%
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Privacy</Text>
        <Text style={styles.metaValue}>{result.privacyStatus}</Text>
      </View>

      {result.imagePreviewUri ? (
        <Image
          source={{ uri: result.imagePreviewUri }}
          style={styles.imagePreview}
          resizeMode="contain"
          accessibilityLabel="Local preview image"
        />
      ) : null}

      <View style={styles.privacyBanner}>
        <Text style={styles.privacyText}>
          This is a local prototype preview. Cloud analysis is not connected in
          this build.
        </Text>
      </View>

      <View style={styles.comingSoonBanner}>
        <Text style={styles.comingSoonText}>
          Cloud share — coming later.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  content: {
    padding: 16,
    gap: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#00f0ff',
    marginBottom: 4,
  },
  summary: {
    fontSize: 14,
    color: '#cccccc',
    lineHeight: 20,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222222',
  },
  metaLabel: {
    fontSize: 13,
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaValue: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  imagePreview: {
    width: '100%',
    height: 200,
    marginTop: 12,
    borderRadius: 8,
    backgroundColor: '#111111',
  },
  privacyBanner: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderLeftWidth: 3,
    borderLeftColor: '#00f0ff',
  },
  privacyText: {
    fontSize: 12,
    color: '#aaaaaa',
    lineHeight: 18,
  },
  comingSoonBanner: {
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderLeftWidth: 3,
    borderLeftColor: '#666666',
  },
  comingSoonText: {
    fontSize: 12,
    color: '#888888',
    lineHeight: 18,
  },
});
