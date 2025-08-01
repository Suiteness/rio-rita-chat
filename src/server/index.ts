import type { 
  ChatMessage, 
  Message, 
  GigaMLInitiateSessionRequest,
  GigaMLInitiateSessionResponse,
  GigaMLReceiveMessageRequest,
  GigaMLReceiveMessageResponse,
  GigaMLCloseSessionRequest
} from "../shared";

// GigaML API Types
export type GigaMLSession = {
  sessionId: string;
  userId: string;
  roomId: string;
  status: "active" | "closed";
  createdAt: string;
};

export class Chat implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private connections: Map<WebSocket, { id: string; gigamlSession?: GigaMLSession }> = new Map();
  
  messages = [] as ChatMessage[];
  gigamlSessions = new Map<string, GigaMLSession>();
  
  // GigaML API Configuration
  private readonly GIGAML_BASE_URL = "https://agents.gigaml.com/webhook";
  private readonly AGENT_ID = "agent_template_8c309492-fbc9-414e-a44a-22be19bee601";

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.initializeDatabase();
  }

  // Cloudflare Workers WebSocket handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    console.log("WebSocket message received in Durable Object:", message);
    await this.handleWebSocketMessage(ws, message as string);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log("WebSocket connection closed in Durable Object", { code, reason, wasClean });
    await this.handleWebSocketClose(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error in Durable Object:", error);
  }

  private async initializeDatabase() {
    // Initialize database tables
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS gigaml_sessions (connection_id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, room_id TEXT, status TEXT, created_at TEXT)`,
    );

    // Load messages from database
    this.messages = this.state.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];
  }

  broadcast(message: string, exclude?: WebSocket[]) {
    for (const [ws, connectionData] of this.connections) {
      if (exclude && exclude.includes(ws)) continue;
      try {
        ws.send(message);
      } catch (error) {
        this.connections.delete(ws);
      }
    }
  }

  broadcastMessage(message: Message, exclude?: WebSocket[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private async callGigaMLAPI<T>(
    endpoint: string,
    method: string,
    body?: any
  ): Promise<T> {
    const apiKey = this.env?.GIGAML_API_KEY;
    if (!apiKey) {
      throw new Error("GIGAML_API_KEY environment variable is not set");
    }

    console.log(`GigaML API call: ${method} ${endpoint}`, JSON.stringify(body, null, 2));

    const response = await fetch(`${this.GIGAML_BASE_URL}/${endpoint}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseText = await response.text();
    console.log(`GigaML API response: ${response.status} ${response.statusText}`, responseText);

    if (!response.ok) {
      throw new Error(`GigaML API error: ${response.status} ${response.statusText} - ${responseText}`);
    }

    // Handle both JSON and text responses
    try {
      return JSON.parse(responseText);
    } catch (e) {
      // If it's not JSON, return the text as a simple object
      return { message: responseText } as T;
    }
  }

  private async initiateGigaMLSession(userId: string, roomId: string, ticketId?: string): Promise<string> {
    const request: GigaMLInitiateSessionRequest = {
      agent_template_id: this.env?.GIGAML_AGENT_ID || this.AGENT_ID, // Use agent_template_id instead of agentId
      userId,
      ticket_id: ticketId || `chat_${roomId}_${Date.now()}`, // Use provided ticket ID or generate one
      metadata: {
        roomId,
        platform: "rio-rita-chat",
      },
    };

    const response = await this.callGigaMLAPI<GigaMLInitiateSessionResponse>(
      "initiate-session",
      "POST",
      request
    );

    // If the response doesn't have a sessionId, generate one based on the ticket_id
    return response.sessionId || request.ticket_id;
  }

  private async sendMessageToGigaML(sessionId: string, message: string, ticketId: string): Promise<void> {
    console.log(`*** sendMessageToGigaML CALLED: sessionId=${sessionId}, ticketId=${ticketId}, message=${message} ***`);
    const request: GigaMLReceiveMessageRequest = {
      sessionId,
      ticket_id: ticketId,
      message_id: `msg_${Date.now()}_${crypto.randomUUID()}`,
      message: {
        type: "text",
        content: message,
        role: "user",
      },
    };

    console.log("*** Request payload to GigaML:", JSON.stringify(request, null, 2), "***");

    await this.callGigaMLAPI<GigaMLReceiveMessageResponse>(
      "receive-message",
      "POST",
      request
    );
  }

  private async closeGigaMLSession(sessionId: string): Promise<void> {
    const request: GigaMLCloseSessionRequest = {
      sessionId,
      reason: "User disconnected",
    };

    await this.callGigaMLAPI(
      "close-session",
      "PUT",
      request
    );
  }

  async handleWebSocketConnect(ws: WebSocket, originalRoomId?: string): Promise<void> {
    const connectionId = crypto.randomUUID();
    console.log(`WebSocket connecting with ID: ${connectionId}`);
    this.connections.set(ws, { id: connectionId });

    // Send existing messages
    ws.send(JSON.stringify({
      type: "all",
      messages: this.messages,
    } satisfies Message));

    // Setup GigaML session (allow connection even if this fails for development)
    try {
      const userId = connectionId;
      const roomId = this.state.id.toString();
      const ticketId = originalRoomId || roomId; // Use original room ID from URL if available
      console.log(`Attempting to initiate GigaML session for user ${userId} in room ${roomId} with ticket ID ${ticketId}`);
      const sessionId = await this.initiateGigaMLSession(userId, roomId, ticketId);
      console.log(`GigaML session ID received: ${sessionId}`);
      
      const session: GigaMLSession = {
        sessionId,
        userId,
        roomId,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      
      this.gigamlSessions.set(connectionId, session);
      const connectionData = this.connections.get(ws);
      if (connectionData) {
        connectionData.gigamlSession = session;
        console.log(`GigaML session attached to connection: ${connectionId}`);
      }
      
      this.state.storage.sql.exec(
        `INSERT INTO gigaml_sessions (connection_id, session_id, user_id, room_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        connectionId,
        sessionId,
        userId,
        roomId,
        "active",
        session.createdAt
      );
      
      await this.registerSessionInRouter(sessionId, roomId);
      console.log(`GigaML session initiated: ${sessionId}`);
    } catch (error) {
      console.error("Failed to initiate GigaML session (continuing without AI):", error);
      // Continue without GigaML session for development
    }
  }

  async handleWebSocketMessage(ws: WebSocket, message: string): Promise<void> {
    console.log("WebSocket message received:", message);
    
    // Broadcast to other connections
    this.broadcast(message, [ws]);

    // Parse and handle message
    const parsed = JSON.parse(message) as Message;
    console.log("Parsed message:", parsed);
    
    if (parsed.type === "add" || parsed.type === "update") {
      this.saveMessage(parsed);
      
      // Send to GigaML if user message
      if (parsed.role === "user") {
        console.log("User message detected, checking GigaML session...");
        const connectionData = this.connections.get(ws);
        console.log("Connection data:", connectionData);
        const session = connectionData?.gigamlSession;
        console.log("GigaML session:", session);
        
        if (session && session.status === "active") {
          try {
            console.log(`Sending message to GigaML: ${parsed.content}`);
            await this.sendMessageToGigaML(session.sessionId, parsed.content, session.sessionId);
            console.log(`Message sent to GigaML: ${session.sessionId}`);
          } catch (error) {
            console.error("Failed to send message to GigaML:", error);
            
            const errorMessage: ChatMessage = {
              id: `error_${Date.now()}`,
              content: "Sorry, I'm having trouble connecting to the AI assistant. Please try again.",
              user: "system",
              role: "assistant",
            };
            
            this.saveMessage(errorMessage);
            this.broadcastMessage({
              type: "add",
              ...errorMessage,
            });
          }
        }
      }
    }
  }

  async handleWebSocketClose(ws: WebSocket): Promise<void> {
    const connectionData = this.connections.get(ws);
    if (connectionData?.gigamlSession) {
      const session = connectionData.gigamlSession;
      try {
        await this.closeGigaMLSession(session.sessionId);
        session.status = "closed";
        
        this.state.storage.sql.exec(
          `UPDATE gigaml_sessions SET status = ? WHERE connection_id = ?`,
          "closed",
          connectionData.id
        );
        
        await this.unregisterSessionFromRouter(session.sessionId);
        console.log(`GigaML session closed: ${session.sessionId}`);
      } catch (error) {
        console.error("Failed to close GigaML session:", error);
      }
      
      this.gigamlSessions.delete(connectionData.id);
    }
    
    this.connections.delete(ws);
  }

  private async registerSessionInRouter(sessionId: string, roomId: string): Promise<void> {
    try {
      const routerId = this.env?.Chat?.idFromName?.("webhook-router");
      if (!routerId || !this.env?.Chat) return;
      
      const routerObject = this.env.Chat.get(routerId);
      
      const registerRequest = new Request("https://example.com/register-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, roomId }),
      });
      
      await routerObject.fetch(registerRequest);
    } catch (error) {
      console.error("Failed to register session in router:", error);
    }
  }

  private async unregisterSessionFromRouter(sessionId: string): Promise<void> {
    try {
      const routerId = this.env?.Chat?.idFromName?.("webhook-router");
      if (!routerId || !this.env?.Chat) return;
      
      const routerObject = this.env.Chat.get(routerId);
      
      const unregisterRequest = new Request("https://example.com/unregister-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      
      await routerObject.fetch(unregisterRequest);
    } catch (error) {
      console.error("Failed to unregister session from router:", error);
    }
  }

  saveMessage(message: ChatMessage) {
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

    this.state.storage.sql.exec(
      `INSERT INTO messages (id, user, role, content) VALUES ('${
        message.id
      }', '${message.user}', '${message.role}', ${JSON.stringify(
        message.content,
      )}) ON CONFLICT (id) DO UPDATE SET content = ${JSON.stringify(
        message.content,
      )}`,
    );
  }

  // Handle HTTP requests (including webhooks)
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Handle WebSocket upgrades
      if (request.headers.get("upgrade") === "websocket") {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        // Immediately establish the connection by accepting the WebSocket
        this.state.acceptWebSocket(server);
        
        // Extract original room ID from request headers if available
        const originalRoomId = request.headers.get("x-original-room-id");
        
        // Set up the connection and initiate GigaML session
        await this.handleWebSocketConnect(server, originalRoomId || undefined);
        
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      }
      
      if (url.pathname === "/webhook/gigaml" && request.method === "POST") {
        return await this.handleGigaMLWebhook(request);
      }
      
      if (url.pathname === "/route-webhook" && request.method === "POST") {
        return await this.routeGigaMLWebhook(request);
      }
      
      if (url.pathname === "/register-session" && request.method === "POST") {
        return await this.handleSessionRegistration(request);
      }
      
      if (url.pathname === "/unregister-session" && request.method === "POST") {
        return await this.handleSessionUnregistration(request);
      }
      
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Error in Durable Object fetch:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Webhook endpoint to receive messages from GigaML
  async handleGigaMLWebhook(request: Request): Promise<Response> {
    try {
      console.log("Received GigaML webhook request");
      
      // Validate authentication
      const authHeader = request.headers.get("Authorization");
      const expectedApiKey = this.env?.GIGAML_API_KEY;
      
      console.log("Auth header present:", !!authHeader);
      console.log("Expected API key present:", !!expectedApiKey);
      
      if (!authHeader || !expectedApiKey) {
        console.log("Missing auth header or API key");
        return new Response("Unauthorized", { status: 401 });
      }
      
      const token = authHeader.replace("Bearer ", "");
      if (token !== expectedApiKey) {
        console.log("Invalid API key");
        return new Response("Unauthorized", { status: 401 });
      }
      
      const body = await request.json() as any;
      console.log("Webhook body:", JSON.stringify(body, null, 2));
      
      if (!body.sessionId || !body.message) {
        console.log("Invalid payload structure");
        return new Response("Invalid webhook payload", { status: 400 });
      }
      
      // Find the session
      let targetSession: GigaMLSession | null = null;
      
      for (const [connectionId, session] of this.gigamlSessions.entries()) {
        if (session.sessionId === body.sessionId) {
          targetSession = session;
          break;
        }
      }
      
      if (!targetSession) {
        const dbResult = this.state.storage.sql
          .exec(`SELECT * FROM gigaml_sessions WHERE session_id = ? AND status = 'active'`, body.sessionId)
          .toArray();
        
        if (dbResult.length === 0) {
          return new Response("Session not found", { status: 404 });
        }
        
        const dbSession = dbResult[0] as any;
        targetSession = {
          sessionId: dbSession.session_id,
          userId: dbSession.user_id,
          roomId: dbSession.room_id,
          status: dbSession.status,
          createdAt: dbSession.created_at,
        };
      }
      
      // Create assistant message
      const assistantMessage: ChatMessage = {
        id: `gigaml_${Date.now()}`,
        content: body.message.content,
        user: "Rio Assistant",
        role: "assistant",
      };
      
      this.saveMessage(assistantMessage);
      this.broadcastMessage({
        type: "add",
        ...assistantMessage,
      });
      
      console.log(`GigaML response processed for session ${body.sessionId}`);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error handling GigaML webhook:", error);
      console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
      return new Response("Internal server error", { status: 500 });
    }
  }

  // Handle session registration in the webhook router
  async handleSessionRegistration(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { sessionId: string; roomId: string };
      
      if (this.state.id.name !== "webhook-router") {
        return new Response("Invalid router", { status: 400 });
      }
      
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS session_registry (session_id TEXT PRIMARY KEY, room_id TEXT, created_at TEXT)`
      );
      
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO session_registry (session_id, room_id, created_at) VALUES (?, ?, ?)`,
        body.sessionId,
        body.roomId,
        new Date().toISOString()
      );
      
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error registering session:", error);
      return new Response("Registration error", { status: 500 });
    }
  }

  async handleSessionUnregistration(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { sessionId: string };
      
      if (this.state.id.name !== "webhook-router") {
        return new Response("Invalid router", { status: 400 });
      }
      
      this.state.storage.sql.exec(
        `DELETE FROM session_registry WHERE session_id = ?`,
        body.sessionId
      );
      
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error unregistering session:", error);
      return new Response("Unregistration error", { status: 500 });
    }
  }

  // Global webhook router
  async routeGigaMLWebhook(request: Request): Promise<Response> {
    try {
      const body = await request.json() as any;
      
      if (!body.sessionId) {
        return new Response("Invalid webhook payload", { status: 400 });
      }
      
      const routerName = this.state.id.name;
      if (routerName !== "webhook-router") {
        return new Response("Invalid router", { status: 400 });
      }
      
      const sessionRegistry = this.state.storage.sql
        .exec(`SELECT room_id FROM session_registry WHERE session_id = ? LIMIT 1`, body.sessionId)
        .toArray();
      
      if (sessionRegistry.length === 0) {
        console.log(`No session found in registry for ${body.sessionId}`);
        return new Response("Session not found", { status: 404 });
      }
      
      const roomId = (sessionRegistry[0] as any).room_id;
      
      const chatId = this.env?.Chat?.idFromString?.(roomId);
      if (!chatId) {
        console.error(`Failed to create chat ID from room ID: ${roomId}`);
        return new Response("Invalid room", { status: 400 });
      }
      
      const chatObject = this.env?.Chat?.get?.(chatId);
      if (!chatObject) {
        return new Response("Room not available", { status: 500 });
      }
      
      const targetRequest = new Request(`https://example.com/webhook/gigaml`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          // Forward authorization header from original request
          ...(request.headers.get("Authorization") && {
            "Authorization": request.headers.get("Authorization")!
          })
        },
        body: JSON.stringify(body),
      });
      
      console.log(`Routing webhook for session ${body.sessionId} to room ${roomId}`);
      return await chatObject.fetch(targetRequest);
    } catch (error) {
      console.error("Error in webhook router:", error);
      return new Response("Router error", { status: 500 });
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      
      // Handle PartyKit-style routes: /parties/{party}/{room}
      const partyMatch = url.pathname.match(/^\/parties\/([^\/]+)\/([^\/]+)$/);
      if (partyMatch) {
        const [, partyName, roomId] = partyMatch;
        
        if (partyName === "chat") {
          const chatId = env.Chat.idFromName(roomId);
          const chatObject = env.Chat.get(chatId);
          
          // Add the original room ID as a header for the Durable Object to use
          const modifiedRequest = new Request(request.url, {
            method: request.method,
            headers: {
              ...Object.fromEntries(request.headers.entries()),
              "x-original-room-id": roomId,
            },
            body: request.body,
          });
          
          return await chatObject.fetch(modifiedRequest);
        }
      }
      
      // Handle GigaML webhook
      if (url.pathname === "/webhook/gigaml" && request.method === "POST") {
        try {
          // Clone the request to preserve the original body
          const clonedRequest = request.clone();
          const body = await clonedRequest.json() as any;
          
          if (!body.sessionId) {
            return new Response("Invalid webhook payload", { status: 400 });
          }
          
          const routerId = env.Chat.idFromName("webhook-router");
          const routerObject = env.Chat.get(routerId);
          
          const routerRequest = new Request(`${url.origin}/route-webhook`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              // Forward authorization if present
              ...(request.headers.get("Authorization") && {
                "Authorization": request.headers.get("Authorization")!
              })
            },
            body: JSON.stringify(body),
          });
          
          return await routerObject.fetch(routerRequest);
        } catch (error) {
          console.error("Error routing GigaML webhook:", error);
          return new Response("Internal server error", { status: 500 });
        }
      }
      
      // Fall back to assets
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Error in worker fetch:", error);
      return new Response("Worker Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
