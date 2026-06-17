import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';

export type RoomDetailTab = 'chat' | 'scans' | 'saved' | 'info';

const TABS: { key: RoomDetailTab; label: string }[] = [
  { key: 'chat', label: 'CHAT' },
  { key: 'scans', label: 'SCANS' },
  { key: 'saved', label: 'SAVED' },
  { key: 'info', label: 'INFO' },
];

type Props = {
  activeTab: RoomDetailTab;
  onChange: (tab: RoomDetailTab) => void;
};

export function RoomDetailTabs({ activeTab, onChange }: Props) {
  return (
    <View style={styles.container}>
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={styles.tab}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.label, isActive && styles.labelActive]}>
              {tab.label}
            </Text>
            {isActive && <View style={styles.indicator} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    minWidth: 64,
    minHeight: 44,
  },
  label: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 2.2,
    color: LUXURY.colors.stone,
  },
  labelActive: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  indicator: {
    position: 'absolute',
    bottom: 0,
    width: 24,
    height: 2,
    borderRadius: 1,
    backgroundColor: LUXURY.colors.plum,
  },
});
