import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];
  gigamlSessionId: string | null = null;

  async fetch(request: Request) {
    const url = new URL(request.url);
    
    // Handle internal GigaML message forwarding
    if (url.pathname === "/gigaml-message" && request.method === "POST") {
      const message = await request.json() as Message;
      this.saveMessage(message as ChatMessage);
      this.broadcastMessage(message);
      return new Response("OK");
    }
    
    return super.fetch(request);
  }

  broadcastMessage(message: Message, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  onStart() {
    // Create the messages table if it doesn't exist
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    // Load the messages from the database
    this.messages = this.ctx.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];
  }

  onConnect(connection: Connection) {
    console.log(`🔌 User connected to room`);
    
    // Send existing messages to the newly connected user
    connection.send(
      JSON.stringify({
        type: "all",
        messages: this.messages,
      } satisfies Message),
    );

    // If this is a new chat room (no messages), initiate GigaML session
    if (this.messages.length === 0) {
      this.initiateGigaMLSession();
    }
  }

  async sendAIWelcomeMessage() {
    const welcomeMessage: ChatMessage = {
      id: crypto.randomUUID(),
      user: "assistant",
      role: "assistant",
      content: "Hello! I'm your AI assistant. How can I help you today?",
    };

    this.saveMessage(welcomeMessage);
    this.broadcastMessage({
      type: "add",
      ...welcomeMessage,
    });
  }

  async initiateGigaMLSession() {
    try {
      console.log(`🤖 Initiating GigaML session`);
      
      // Use the room ID as the ticket ID for easy mapping
      const roomId = this.ctx.id.toString();
      const ticketId = roomId;
      
      const response = await fetch("https://agents.gigaml.com/webhook/initiate-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.GIGAML_API_KEY}`,
        },
        body: JSON.stringify({
          ticket_id: ticketId,
          agent_template_id: this.env.GIGAML_AGENT_ID,
          initialization_values: {
            room_type: "hotel_chat",
            service_type: "guest_services"
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`GigaML initiate session error: ${response.status} ${response.statusText}`);
      }

      // Try to parse JSON, but handle plain text responses
      let data;
      const responseText = await response.text();
      try {
        data = JSON.parse(responseText);
      } catch (jsonError) {
        console.log(`📄 GigaML session response (plain text): ${responseText}`);
        data = { session_id: ticketId }; // Use our ticket ID if no JSON
      }
      
      this.gigamlSessionId = data.session_id || ticketId; // Use our ticket ID as session ID
      
      console.log(`✅ GigaML session initiated with ticket ID: ${this.gigamlSessionId}`);
      console.log(`🔗 Room ID: ${roomId} mapped to ticket ID: ${ticketId}`);
    } catch (error) {
      console.error("❌ Error initiating GigaML session:", error);
      
      // Fallback to manual welcome message
      this.sendAIWelcomeMessage();
    }
  }

  saveMessage(message: ChatMessage) {
    // Check if the message already exists
    const existingMessage = this.messages.find((m) => m.id === message.id);
    if (existingMessage) {
      this.messages = this.messages.map((m) => {
        if (m.id === message.id) {
          return message;
        }
        return m;
      });
    } else {
      this.messages.push(message);
    }

    // Use parameterized queries to prevent SQL injection
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, user, role, content) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET content = ?`,
      message.id,
      message.user,
      message.role,
      JSON.stringify(message.content),
      JSON.stringify(message.content)
    );
  }

  async sendToGigaML(userMessage: string, ticketId: string) {
    try {
      console.log(`🤖 Sending message to GigaML`);
      
      const response = await fetch("https://agents.gigaml.com/webhook/receive-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.GIGAML_API_KEY}`,
        },
        body: JSON.stringify({
          ticket_id: ticketId,
          message_id: crypto.randomUUID(),
          message: {
            role: "user",
            content: userMessage,
            timestamp: Date.now()
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`GigaML receive message error: ${response.status} ${response.statusText}`);
      }

      console.log(`✅ Message sent to GigaML`);
    } catch (error) {
      console.error("❌ Error sending message to GigaML:", error);
      
      // Send an error message to the user
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        user: "assistant",
        role: "assistant",
        content: "I'm sorry, I'm having trouble responding right now. Please try again.",
      };

      this.saveMessage(errorMessage);
      this.broadcastMessage({
        type: "add",
        ...errorMessage,
      });
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    try {
      const parsed = JSON.parse(message as string) as Message;
      
      if (parsed.type === "add" || parsed.type === "update") {
        console.log(`💬 Received message from ${parsed.user}: ${parsed.content}`);
        
        // Save the user's message
        this.saveMessage(parsed);
        
        // Broadcast the user's message to all connections
        this.broadcast(message);

        // If this is a user message (not from assistant), get AI response
        if (parsed.role === "user" && this.gigamlSessionId) {
          this.sendToGigaML(parsed.content as string, this.gigamlSessionId);
        }
      } else {
        // For other message types, just broadcast
        this.broadcast(message);
      }
    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  }

  onClose(connection: Connection) {
    console.log(`🔌❌ User disconnected from room`);
  }

  onError(connection: Connection, error: Error) {
    console.error(`🔌❌ WebSocket error:`, error);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle GigaML webhook
    if (url.pathname === "/webhook/gigaml" && request.method === "POST") {
      try {
        const data = await request.json() as any;
        const { ticket_id, message_id, message } = data;
        
        console.log(`🤖 Received GigaML webhook for ticket: ${ticket_id}`);
        console.log(`📋 Webhook data:`, JSON.stringify(data, null, 2));
        
        // Extract message content from GigaML format
        let messageContent = "";
        if (message?.content) {
          if (Array.isArray(message.content)) {
            // Handle structured content array
            messageContent = message.content
              .filter((item: any) => item.type === "text")
              .map((item: any) => item.text)
              .join(" ");
          } else if (typeof message.content === "string") {
            // Handle simple string content
            messageContent = message.content;
          }
        }
        
        if (!messageContent) {
          console.error("❌ No valid message content found in GigaML webhook");
          console.log(`📋 Full message object:`, JSON.stringify(message, null, 2));
          return new Response("No content", { status: 400 });
        }
        
        // Find the Durable Object for this session/room
        const roomId = ticket_id || "default-room";
        console.log(`🔍 Looking for room with ID: ${roomId}`);
        const id = env.Chat.idFromName(roomId);
        const chatObject = env.Chat.get(id);
        
        // Forward the message to the chat room
        await chatObject.fetch(new Request("http://internal/gigaml-message", {
          method: "POST",
          body: JSON.stringify({
            type: "add",
            id: message_id || crypto.randomUUID(),
            user: "assistant",
            role: "assistant",
            content: messageContent,
          }),
        }));
        
        console.log(`✅ GigaML message forwarded to room: ${roomId}`);
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("❌ Error handling GigaML webhook:", error);
        return new Response("Error", { status: 500 });
      }
    }
    
    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
