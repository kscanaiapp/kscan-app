import { useState, useCallback } from 'react';
import {
  STYLE_CHAT_MONTHLY_MESSAGE_LIMIT,
  STYLE_CHAT_NEAR_LIMIT_THRESHOLD,
} from '../constants/styleChat';

// v0.1: in-memory usage tracking. Replace with Supabase query against
// style_chat_usage once server-side increment is wired up.
export function useStyleChatUsage() {
  const [messagesUsed, setMessagesUsed] = useState(0);

  const messagesLimit = STYLE_CHAT_MONTHLY_MESSAGE_LIMIT;
  const messagesRemaining = Math.max(0, messagesLimit - messagesUsed);
  const isNearLimit = messagesRemaining <= STYLE_CHAT_NEAR_LIMIT_THRESHOLD;
  const canSend = messagesRemaining > 0;

  const incrementUsage = useCallback(() => {
    setMessagesUsed(prev => prev + 1);
  }, []);

  return {
    messagesUsed,
    messagesLimit,
    messagesRemaining,
    isNearLimit,
    canSend,
    incrementUsage,
  };
}
