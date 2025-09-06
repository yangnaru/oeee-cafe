declare global {
  interface Window {
    addChatMessage?: (message: {
      id: string;
      type: "join" | "leave" | "user";
      userId: string;
      username: string;
      message: string;
      timestamp: number;
    }) => void;
    handleSnapshotRequest?: (timestamp: number) => void;
  }
}

export {};