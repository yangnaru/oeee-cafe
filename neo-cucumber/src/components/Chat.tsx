import { useState, useEffect, useRef, useCallback } from 'react';
import { encodeChat } from '../utils/binaryProtocol';

interface ChatMessage {
  id: string;
  type: 'user' | 'system';
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

interface ChatProps {
  wsRef: React.RefObject<WebSocket | null>;
  userId: string;
  onChatMessage: (message: ChatMessage) => void;
}

export const Chat: React.FC<ChatProps> = ({ wsRef, userId, onChatMessage }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle incoming chat messages
  const addMessage = useCallback((message: ChatMessage) => {
    setMessages(prev => [...prev, message]);
    onChatMessage(message);
  }, [onChatMessage]);

  // Expose addMessage to parent component
  useEffect(() => {
    (window as any).addChatMessage = addMessage;
    return () => {
      delete (window as any).addChatMessage;
    };
  }, [addMessage]);

  // Send chat message
  const sendMessage = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !inputValue.trim()) {
      return;
    }

    try {
      const message = inputValue.trim();
      if (message.length > 500) {
        alert('Message too long (max 500 characters)');
        return;
      }

      const binaryMessage = encodeChat(userId, message, Date.now());
      ws.send(binaryMessage);
      
      setInputValue('');
      inputRef.current?.focus();
    } catch (error) {
      console.error('Failed to send chat message:', error);
    }
  }, [wsRef, userId, inputValue]);

  // Handle IME composition events
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
  }, []);

  // Handle Enter key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage, isComposing]);

  // Format timestamp
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  // Truncate user ID for display
  const formatUserId = (userId: string) => {
    return userId.substring(0, 8);
  };

  return (
    <div id="chat-container">
      <h3>Chat</h3>
      <div id="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.type === 'system' ? 'system-message' : ''}`}>
            {msg.type === 'system' ? (
              <div className="chat-text system-text">{msg.message}</div>
            ) : (
              <>
                <div className="chat-header">
                  <span className="chat-username">
                    {formatUserId(msg.userId)}
                  </span>
                  <span className="chat-timestamp">
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
                <div className="chat-text">{msg.message}</div>
              </>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div id="chat-input-container">
        <input
          ref={inputRef}
          id="chat-input"
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder="Type a message..."
          maxLength={500}
        />
        <button
          id="chat-send"
          onClick={sendMessage}
          disabled={!inputValue.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
};