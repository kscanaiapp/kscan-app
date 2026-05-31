import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { DressingRoom, Look } from '../types/styleObjects';
import { listDressingRooms, listLooks } from '../services/styleObjects';

export function useDressingRooms() {
  const [rooms, setRooms] = useState<DressingRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRooms(await listDressingRooms());
    } catch (err: any) {
      setError(err?.message || 'Unable to load Dressing Rooms.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { rooms, loading, error, reload, setRooms };
}

export function useLooks() {
  const [looks, setLooks] = useState<Look[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLooks(await listLooks());
    } catch (err: any) {
      setError(err?.message || 'Unable to load Looks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { looks, loading, error, reload, setLooks };
}
