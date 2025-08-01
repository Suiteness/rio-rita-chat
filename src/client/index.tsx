import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useEffect, useRef } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useParams,
} from "react-router";
import { nanoid } from "nanoid";

import { type ChatMessage, type Message } from "../shared";

// Avatar component for users
function Avatar({ user, role }: { user: string; role: "user" | "assistant" }) {
  const isAI = role === "assistant";
  const displayText = isAI ? "🤖" : "Me";

  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
        isAI ? "bg-blue-500 text-white" : "bg-gray-300 text-gray-700"
      }`}
    >
      {displayText}
    </div>
  );
}

// Individual chat message component
function ChatBubble({
  message,
  isOwn,
  isLastUserMessage,
}: {
  message: ChatMessage;
  isOwn: boolean;
  isLastUserMessage?: boolean;
}) {
  const isAI = message.role === "assistant";
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isOwn && !isAI) {
    // Own message - right aligned with blue background
    return (
      <div className="flex items-start gap-2.5 justify-end">
        <div
          className="flex flex-col w-full max-w-[320px] leading-1.5 p-4 border-gray-200 bg-blue-500 rounded-s-xl rounded-ee-xl md:bg-blue-500/95 md:backdrop-blur-sm"
          title={timestamp}
        >
          <p className="text-sm font-normal text-white">{message.content}</p>
          {isLastUserMessage && (
            <span className="text-xs font-normal text-blue-100 mt-1">
              Delivered
            </span>
          )}
        </div>
        <Avatar user={message.user} role={message.role} />
      </div>
    );
  }

  // AI or other messages - left aligned with gray background
  return (
    <div className="flex items-start gap-2.5">
      <Avatar user={message.user} role={message.role} />
      <div
        className="flex flex-col w-full max-w-[320px] leading-1.5 p-4 border-gray-200 bg-gray-100 rounded-e-xl rounded-es-xl dark:bg-gray-700 md:bg-white/95 md:backdrop-blur-sm md:dark:bg-gray-800/95"
        title={timestamp}
      >
        {isAI && (
          <div className="flex items-center space-x-2 rtl:space-x-reverse mb-2">
            <span className="text-xs font-semibold text-purple-600 dark:text-purple-300">
              Rio Rita
            </span>
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              {timestamp}
            </span>
          </div>
        )}
        <p className="text-sm font-normal py-2.5 text-gray-900 dark:text-white">
          {message.content}
        </p>
      </div>
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { room } = useParams();

  // Simple name for the user since it's just them and Rio Rita
  const [displayName] = useState("Me");

  // Ensure messages is always an array
  const safeMessages = Array.isArray(messages) ? messages : [];

  const socket = usePartySocket({
    party: "chat",
    room,
    onMessage: (evt) => {
      try {
        const message = JSON.parse(evt.data as string) as Message;
        if (message.type === "add") {
          const foundIndex = safeMessages.findIndex((m) => m.id === message.id);
          if (foundIndex === -1) {
            // probably someone else who added a message
            setMessages((prevMessages) => {
              const currentMessages = Array.isArray(prevMessages)
                ? prevMessages
                : [];
              return [
                ...currentMessages,
                {
                  id: message.id,
                  content: message.content,
                  user: message.user,
                  role: message.role,
                },
              ];
            });
          } else {
            // this usually means we ourselves added a message
            // and it was broadcasted back
            // so let's replace the message with the new message
            setMessages((prevMessages) => {
              const currentMessages = Array.isArray(prevMessages)
                ? prevMessages
                : [];
              return currentMessages
                .slice(0, foundIndex)
                .concat({
                  id: message.id,
                  content: message.content,
                  user: message.user,
                  role: message.role,
                })
                .concat(currentMessages.slice(foundIndex + 1));
            });
          }
        } else if (message.type === "update") {
          setMessages((prevMessages) => {
            const currentMessages = Array.isArray(prevMessages)
              ? prevMessages
              : [];
            return currentMessages.map((m) =>
              m.id === message.id
                ? {
                    id: message.id,
                    content: message.content,
                    user: message.user,
                    role: message.role,
                  }
                : m
            );
          });
        } else if (message.type === "connection") {
          // Handle connection status messages
          console.log("Connection status:", message);
        } else if (message.type === "all") {
          // Handle messages list
          const messagesList = Array.isArray(message.messages)
            ? message.messages
            : [];
          setMessages(messagesList);
        } else {
          // Unknown message type, ignore
          console.log("Unknown message type:", message);
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    },
  });

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [safeMessages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const chatMessage: ChatMessage = {
      id: nanoid(8),
      content: inputValue.trim(),
      user: displayName,
      role: "user",
    };

    setMessages((prevMessages) => {
      const currentMessages = Array.isArray(prevMessages) ? prevMessages : [];
      return [...currentMessages, chatMessage];
    });

    socket.send(
      JSON.stringify({
        type: "add",
        ...chatMessage,
      } satisfies Message)
    );

    setInputValue("");
  };

  return (
    <div className="flex flex-col h-full w-full relative min-h-screen md:min-h-0">
      {/* Background image for medium and larger screens */}
      <div
        className="hidden md:block fixed inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage:
            "url('https://i.travelapi.com/lodging/1000000/20000/19900/19837/b756c453_z.jpg')",
        }}
      />

      {/* Chat container with backdrop blur for medium+ screens */}
      <div className="flex flex-col h-full max-w-6xl md:mx-auto md:px-8 lg:px-16 relative z-10 md:bg-white/80 md:dark:bg-gray-900/80 md:backdrop-blur-md md:shadow-xl bg-white dark:bg-gray-800 shadow-lg md:mt-8 md:mb-8 md:rounded-lg md:overflow-hidden pt-safe-top pb-safe-bottom md:pt-0 md:pb-0">
        {/* Header */}
        <div className="border-b border-gray-200 dark:border-gray-700 p-4 bg-white/90 md:bg-transparent md:dark:bg-transparent dark:bg-gray-800 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
                Chat with Rio Rita
              </h1>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-400 rounded-full"></div>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Online
              </span>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 md:bg-transparent">
          {safeMessages.length === 0 ? (
            <div
              className="flex items-center justify-center h-full"
              style={{ height: "calc(100% - 2rem)" }}
            >
              <div className="text-center">
                <div className="w-24 h-24 flex items-center justify-center mx-auto mb-4">
                  <span className="text-2xl">
                    <img
                      src="https://imagedelivery.net/j444tmn-dIClF7t-Q3FQdw/1f51e6f0-1ab5-4345-b06d-851eeb360700/360x240"
                      alt="Rio Rita Chat Icon"
                    />
                  </span>
                </div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2 md:text-gray-800 md:dark:text-gray-200">
                  Start the conversation
                </h3>
                <p className="text-gray-500 dark:text-gray-400 md:text-gray-600 md:dark:text-gray-300">
                  Send a message to Rio Rita.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {safeMessages.map((message, index) => {
                // Find the last user message index (much simpler)
                const lastUserMessageIndex = safeMessages
                  .slice()
                  .reverse()
                  .findIndex((m) => m.role === "user");
                const actualLastUserMessageIndex =
                  lastUserMessageIndex === -1
                    ? -1
                    : safeMessages.length - 1 - lastUserMessageIndex;

                return (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    isOwn={message.user === displayName}
                    isLastUserMessage={
                      index === actualLastUserMessageIndex &&
                      message.role === "user"
                    }
                  />
                );
              })}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Form */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-white/90 md:bg-transparent md:dark:bg-transparent dark:bg-gray-800 flex-shrink-0">
          <form onSubmit={handleSubmit} className="flex items-center space-x-3">
            <div className="flex-1">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400 md:bg-white/90 md:backdrop-blur-sm md:dark:bg-gray-800/90"
                placeholder="Type your message..."
                autoComplete="off"
              />
            </div>
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Navigate to={`/${nanoid()}`} />} />
      <Route path="/:room" element={<App />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  </BrowserRouter>
);
