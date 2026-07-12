export type RetryableStyleChatSend<TAttachments> = {
  content: string;
  userMessageId: string | null;
  attachments: TAttachments | null;
};

export type StyleChatRetryState<TAttachments> = {
  clear: () => void;
  remember: (send: RetryableStyleChatSend<TAttachments>) => void;
  consume: () => RetryableStyleChatSend<TAttachments> | null;
};

export function createStyleChatRetryState<TAttachments>(): StyleChatRetryState<TAttachments> {
  let pending: RetryableStyleChatSend<TAttachments> | null = null;

  return {
    clear() {
      pending = null;
    },
    remember(send) {
      pending = send;
    },
    consume() {
      const send = pending;
      pending = null;
      return send;
    },
  };
}
