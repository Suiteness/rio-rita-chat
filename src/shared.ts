export type ChatMessage = {
  id: string;
  content: string;
  user: string;
  role: "user" | "assistant";
};

export type Message =
  | {
      type: "add";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "update";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "all";
      messages: ChatMessage[];
    };

// GigaML API Types
export type GigaMLSession = {
  sessionId: string;
  userId: string;
  status: "active" | "closed";
  createdAt: string;
};

export type GigaMLInitiateSessionRequest = {
  agent_template_id: string;
  ticket_id: string;
  initialization_values?: Record<string, any>;
};

export type GigaMLInitiateSessionResponse = {
  sessionId?: string;
  status?: string;
  message?: string;
};

export type GigaMLReceiveMessageRequest = {
  sessionId: string;
  ticket_id: string;
  message_id: string;
  message: {
    type: "text" | "image" | "file";
    content: string;
    role: "user" | "assistant";
    metadata?: Record<string, any>;
  };
};

export type GigaMLReceiveMessageResponse = {
  status: string;
  messageId: string;
};

export type GigaMLSendMessageRequest = {
  sessionId: string;
  message: {
    type: "text" | "image" | "file";
    content: string;
    metadata?: Record<string, any>;
  };
};

export type GigaMLCloseSessionRequest = {
  sessionId: string;
  reason?: string;
};
