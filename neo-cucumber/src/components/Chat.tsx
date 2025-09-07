import { useState, useEffect, useRef, useCallback } from "react";
import { encodeChat } from "../utils/binaryProtocol";
import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { getUserColors } from "../utils/userColors";

interface ChatMessage {
  id: string;
  type: "user" | "system" | "join" | "leave";
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

interface Participant {
  userId: string;
  username: string;
  joinedAt: number;
}

interface ChatProps {
  wsRef: React.RefObject<WebSocket | null>;
  userId: string;
  participants: Map<string, Participant>;
  onChatMessage: (message: ChatMessage) => void;
  onMinimizedChange?: (isMinimized: boolean) => void;
  onAddMessage?: (
    addMessageFn: (message: {
      id: string;
      type: "join" | "leave" | "user";
      userId: string;
      username: string;
      message: string;
      timestamp: number;
    }) => void
  ) => void;
}

export const Chat = ({
  wsRef,
  userId,
  participants,
  onChatMessage,
  onMinimizedChange,
  onAddMessage,
}: ChatProps) => {
  const { t } = useLingui();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle incoming chat messages
  const addMessage = useCallback(
    (message: ChatMessage) => {
      // Add message to chat history (including join/leave for display)
      setMessages((prev) => [...prev, message]);
      onChatMessage(message);
    },
    [onChatMessage]
  );

  // Expose addMessage to parent component via callback
  useEffect(() => {
    if (onAddMessage) {
      onAddMessage(addMessage);
    }
  }, [onAddMessage, addMessage]);

  // Send chat message
  const sendMessage = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !inputValue.trim()) {
      return;
    }

    try {
      const message = inputValue.trim();
      if (message.length > 500) {
        alert("Message too long (max 500 characters)");
        return;
      }

      const binaryMessage = encodeChat(userId, message, Date.now());
      ws.send(binaryMessage);

      setInputValue("");
      inputRef.current?.focus();
    } catch (error) {
      console.error("Failed to send chat message:", error);
    }
  }, [wsRef, userId, inputValue]);

  // Handle IME composition events
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
  }, []);

  // Handle input focus for mobile
  const handleInputFocus = useCallback(() => {
    // Scroll input into view on mobile after a brief delay to allow keyboard to appear
    setTimeout(() => {
      inputRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 300);
  }, []);

  // Handle Enter key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !isComposing) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage, isComposing]
  );

  // Format timestamp
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Generate unique color and background for participant based on username
  const getUserStyle = (username: string) => {
    const colors = getUserColors(username);
    return {
      color: colors.textColor,
      backgroundColor: colors.backgroundColor,
      padding: "2px 6px",
      borderRadius: "3px",
      fontSize: "inherit",
      fontWeight: "bold",
      // Override any inherited styles
      borderColor: colors.backgroundColor,
    };
  };

  return (
    <div
      className={`${
        isMinimized ? "h-12" : "h-full"
      } flex flex-col gap-4 p-4 touch-auto select-auto`}
    >
      <div className="flex items-center flex-row">
        <button
          onClick={() => {
            const newMinimized = !isMinimized;
            setIsMinimized(newMinimized);
            onMinimizedChange?.(newMinimized);
          }}
          className="p-1 text-main hover:text-highlight cursor-pointer text-sm"
          title={isMinimized ? "Maximize chat" : "Minimize chat"}
        >
          <Icon icon="material-symbols:chat" width={16} height={16} />{" "}
        </button>
        {!isMinimized && (
          <p>
            <Trans>Participants</Trans> ({participants.size})
          </p>
        )}
      </div>
      {!isMinimized && (
        <>
          <div className="flex flex-row gap-2 w-full">
            {Array.from(participants.values())
              .sort((a, b) => a.joinedAt - b.joinedAt)
              .map((participant) => (
                <div
                  key={participant.userId}
                  className="items-center py-0.5 text-xs"
                  style={getUserStyle(participant.username)}
                >
                  {participant.username}
                </div>
              ))}
            {participants.size === 0 && (
              <div className="text-main opacity-50 italic text-xs">
                No participants
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 border border-main bg-main text-xs leading-relaxed flex flex-col justify-end">
            <div>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`mb-3 p-2 ${
                    msg.type === "system" ||
                    msg.type === "join" ||
                    msg.type === "leave"
                      ? "py-1 mb-2"
                      : "border-b border-main"
                  } last:border-b-0`}
                >
                  {msg.type === "system" ||
                  msg.type === "join" ||
                  msg.type === "leave" ? (
                    <div className="italic text-main opacity-80 text-xs">
                      {msg.type === "join"
                        ? `${msg.username} joined`
                        : msg.type === "leave"
                        ? `${msg.username} left the session`
                        : msg.message}
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between items-center mb-1">
                        <span className="" style={getUserStyle(msg.username)}>
                          {msg.username}
                        </span>
                        <span className="text-xs text-main opacity-70">
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                      <div className="break-words text-main text-xs">
                        {msg.message}
                      </div>
                    </>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onFocus={handleInputFocus}
              placeholder={t`Type a message...`}
              maxLength={500}
              className="flex-1 p-2 border border-main bg-main text-main text-xs font-sans focus:outline-2 focus:outline-highlight focus:-outline-offset-2"
            />
            <button
              onClick={sendMessage}
              disabled={!inputValue.trim()}
              className="px-4 py-2 border border-main bg-main text-main cursor-pointer text-xs font-sans disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white"
            >
              <Trans>Send</Trans>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
