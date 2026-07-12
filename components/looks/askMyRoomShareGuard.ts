export type AskMyRoomShareGuard = {
  tryBegin: () => boolean;
  rememberCreatedRoom: (title: string, roomId: string) => void;
  getCreatedRoomId: (title: string) => string | null;
  releaseForRetry: () => void;
  reset: () => void;
};

export function createAskMyRoomShareGuard(): AskMyRoomShareGuard {
  let inFlight = false;
  let createdRoom: { title: string; roomId: string } | null = null;

  return {
    tryBegin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    rememberCreatedRoom(title, roomId) {
      createdRoom = { title, roomId };
    },
    getCreatedRoomId(title) {
      return createdRoom?.title === title ? createdRoom.roomId : null;
    },
    releaseForRetry() {
      inFlight = false;
    },
    reset() {
      inFlight = false;
      createdRoom = null;
    },
  };
}
