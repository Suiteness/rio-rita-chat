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
  ticketId: string;  // GigaML's ticket_id (used as primary identifier)
  userId: string;
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
      `CREATE TABLE IF NOT EXISTS gigaml_sessions (connection_id TEXT PRIMARY KEY, ticket_id TEXT, user_id TEXT, room_id TEXT, status TEXT, created_at TEXT)`,
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

    console.log(`GigaML API call: ${method} ${this.GIGAML_BASE_URL}/${endpoint}`);
    console.log("Request body:", JSON.stringify(body, null, 2));

    const response = await fetch(`${this.GIGAML_BASE_URL}/${endpoint}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseText = await response.text();
    console.log(`GigaML API response: ${response.status} ${response.statusText}`);
    console.log("Response body:", responseText);

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

  private async initiateGigaMLSession(userId: string, ticketId: string): Promise<string> {
    const request: GigaMLInitiateSessionRequest = {
      agent_template_id: this.env?.GIGAML_AGENT_ID || this.AGENT_ID,
      ticket_id: ticketId,
      initialization_values: {
        userId,
        platform: "rio-rita-chat",
      },
    };

    const response = await this.callGigaMLAPI<GigaMLInitiateSessionResponse>(
      "initiate-session",
      "POST",
      request
    );

    return ticketId; // Return the ticketId we sent
  }

  private async sendMessageToGigaML(ticketId: string, message: string): Promise<void> {
    console.log(`*** sendMessageToGigaML CALLED: ticketId=${ticketId}, message=${message} ***`);
    const request: GigaMLReceiveMessageRequest = {
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

  private async closeGigaMLSession(ticketId: string): Promise<void> {
    const request: GigaMLCloseSessionRequest = {
      ticket_id: ticketId,
      reason: "user_request",
      status: "COMPLETED"
    };

    await this.callGigaMLAPI(
      "close-session",
      "PUT",
      request
    );
  }



  async setupGigaMLSessionAsync(ws: WebSocket, connectionId: string, originalRoomId?: string): Promise<void> {
    try {
      const userId = connectionId;
      const ticketId = originalRoomId || this.state.id.toString();
      console.log(`🔄 Setting up GigaML session for ${connectionId} with ticket ID: ${ticketId}`);
      
      // Check if we already have an active session for this ticket ID
      let existingSession: GigaMLSession | null = null;
      
      // First check in memory
      for (const [_, session] of this.gigamlSessions.entries()) {
        if (session.ticketId === ticketId && session.status === "active") {
          existingSession = session;
          console.log(`🔄 Found existing session in memory: ${session.ticketId}`);
          break;
        }
      }
      
      // If not in memory, check database
      if (!existingSession) {
        const dbResult = this.state.storage.sql
          .exec(`SELECT * FROM gigaml_sessions WHERE ticket_id = ? AND status = 'active' LIMIT 1`, ticketId)
          .toArray();
        
        if (dbResult.length > 0) {
          const dbSession = dbResult[0] as any;
          existingSession = {
            ticketId: dbSession.ticket_id,
            userId: dbSession.user_id,
            status: dbSession.status,
            createdAt: dbSession.created_at,
          };
          console.log(`🔄 Found existing session in database: ${existingSession.ticketId}`);
        }
      }
      
      let session: GigaMLSession;
      
      if (existingSession) {
        // Reuse existing session
        session = existingSession;
        console.log(`🔄 Reusing existing GigaML session: ${session.ticketId}`);
        
        // Ensure session is registered in router (critical for webhook routing)
        await this.registerSessionInRouter(session.ticketId, ticketId);
        console.log(`🔄 Session re-registered in webhook router: ${session.ticketId}`);
      } else {
        // Create new session
        console.log(`🆕 Creating new GigaML session for user ${userId} with ticket ID ${ticketId}`);
        const returnedTicketId = await this.initiateGigaMLSession(userId, ticketId);
        console.log(`🆕 GigaML ticket ID confirmed: ${returnedTicketId}`);
        
        session = {
          ticketId: returnedTicketId,
          userId,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        
        // Store in database
        this.state.storage.sql.exec(
          `INSERT INTO gigaml_sessions (connection_id, ticket_id, user_id, room_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          connectionId,
          returnedTicketId,
          userId,
          ticketId,
          "active",
          session.createdAt
        );
        
        await this.registerSessionInRouter(returnedTicketId, ticketId);
        console.log(`🆕 New GigaML session created: ${returnedTicketId}`);
      }
      
      // Attach session to this connection
      // First, clean up any stale mappings for this session
      for (const [oldConnectionId, existingSession] of this.gigamlSessions.entries()) {
        if (existingSession.ticketId === session.ticketId && oldConnectionId !== connectionId) {
          console.log(`🧹 Cleaning up stale connection mapping: ${oldConnectionId} -> ${existingSession.ticketId}`);
          this.gigamlSessions.delete(oldConnectionId);
        }
      }
      
      // Now attach the session to the new connection
      this.gigamlSessions.set(connectionId, session);
      
      // Update the connection data with the session
      const connectionData = this.connections.get(ws);
      if (connectionData) {
        connectionData.gigamlSession = session;
        console.log(`🔗 GigaML session attached to connection: ${connectionId} -> ${session.ticketId}`);
      } else {
        console.error(`❌ Could not find connection data for ${connectionId} to attach session`);
        // Try to recover by re-creating the connection data
        const newConnectionData: { id: string; gigamlSession?: GigaMLSession } = { 
          id: connectionId, 
          gigamlSession: session 
        };
        this.connections.set(ws, newConnectionData);
        console.log(`🔧 Recovered connection data for ${connectionId}`);
      }
      
      // Double-check that the connection is properly set up
      const finalConnectionData = this.connections.get(ws);
      if (!finalConnectionData) {
        console.error(`❌ CRITICAL: Connection data still missing after setup for ${connectionId}`);
        // Force recreate the connection data
        this.connections.set(ws, { id: connectionId, gigamlSession: session });
        console.log(`🚨 Force-created connection data for ${connectionId}`);
      } else if (!finalConnectionData.gigamlSession) {
        console.error(`❌ CRITICAL: GigaML session missing from connection data for ${connectionId}`);
        finalConnectionData.gigamlSession = session;
        console.log(`� Force-attached session to connection data for ${connectionId}`);
      }
      
      console.log(`�📊 Active sessions in memory: ${this.gigamlSessions.size}`);
      console.log(`📊 Active connections: ${this.connections.size}`);
      console.log(`🔍 Final connection check for ${connectionId}:`, this.connections.get(ws) ? 'OK' : 'MISSING');
    } catch (error) {
      console.error(`❌ Failed to setup GigaML session for ${connectionId}:`, error);
      console.error("Error details:", error instanceof Error ? error.stack : error);
      
      // Ensure connection data exists even if GigaML setup fails
      const connectionData = this.connections.get(ws);
      if (!connectionData) {
        const fallbackConnectionData: { id: string; gigamlSession?: GigaMLSession } = { id: connectionId };
        this.connections.set(ws, fallbackConnectionData);
        console.log(`🔧 Created fallback connection data for ${connectionId}`);
      }
      
      // Send an error message to the user
      try {
        const errorMessage: ChatMessage = {
          id: `error_${Date.now()}`,
          content: "AI assistant is currently unavailable. You can still send messages and they will be processed when the service is restored.",
          user: "system",
          role: "assistant",
        };
        
        this.saveMessage(errorMessage);
        this.broadcastMessage({
          type: "add",
          ...errorMessage,
        });
      } catch (msgError) {
        console.error("Failed to send error message to user:", msgError);
      }
      
      // Continue without GigaML session but maintain the connection
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
        console.log(`🔍 Connections map size: ${this.connections.size}`);
        console.log(`🔍 Sessions map size: ${this.gigamlSessions.size}`);
        console.log(`🔍 WebSocket in connections map: ${this.connections.has(ws)}`);
        
        let connectionData = this.connections.get(ws);
        console.log("Connection data:", connectionData);
        console.log(`🔍 Connection data exists: ${!!connectionData}`);
        
        if (connectionData) {
          console.log(`🔍 Connection ID: ${connectionData.id}`);
          console.log(`🔍 Has GigaML session: ${!!connectionData.gigamlSession}`);
          if (connectionData.gigamlSession) {
            console.log(`🔍 Session ticket ID: ${connectionData.gigamlSession.ticketId}`);
            console.log(`🔍 Session status: ${connectionData.gigamlSession.status}`);
          }
        }
        
        // If connection data is missing, try to recover
        if (!connectionData) {
          console.error("❌ Connection data is missing! Attempting recovery...");
          console.log(`🔍 Current sessions in memory: ${this.gigamlSessions.size}`);
          console.log(`🔍 Current connections: ${this.connections.size}`);
          
          // Check if we can find a GigaML session for any connection that might be this one
          // Look for sessions that might belong to this connection
          let recoveredSession: GigaMLSession | null = null;
          let recoveredConnectionId: string | null = null;
          
          // Try to find the most recent active session as a fallback
          for (const [connId, session] of this.gigamlSessions.entries()) {
            if (session.status === "active") {
              recoveredSession = session;
              recoveredConnectionId = connId;
              console.log(`🔧 Found active session that could belong to this connection: ${session.ticketId}`);
              break;
            }
          }
          
          // If no session in memory, check database for active sessions
          if (!recoveredSession) {
            console.log(`🔍 No sessions in memory, checking database...`);
            const dbSessions = this.state.storage.sql
              .exec(`SELECT * FROM gigaml_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`)
              .toArray();
            
            if (dbSessions.length > 0) {
              const dbSession = dbSessions[0] as any;
              recoveredSession = {
                ticketId: dbSession.ticket_id,
                userId: dbSession.user_id,
                status: dbSession.status,
                createdAt: dbSession.created_at,
              };
              recoveredConnectionId = crypto.randomUUID(); // Generate new connection ID
              console.log(`🔧 Recovered session from database: ${recoveredSession.ticketId}`);
              
              // Add session back to memory
              this.gigamlSessions.set(recoveredConnectionId, recoveredSession);
            }
          }
          
          if (recoveredSession && recoveredConnectionId) {
            // Recreate connection data with the recovered session
            connectionData = { 
              id: recoveredConnectionId, 
              gigamlSession: recoveredSession 
            };
            this.connections.set(ws, connectionData);
            console.log(`🔧 Recovered connection data for WebSocket with session: ${recoveredSession.ticketId}`);
          } else {
            console.error("❌ No active sessions available for recovery");
            
            // Try to recreate a session based on the message context
            console.log(`🔄 Attempting to recreate session...`);
            try {
              const newConnectionId = crypto.randomUUID();
              const connectionData: { id: string; gigamlSession?: GigaMLSession } = { id: newConnectionId };
              this.connections.set(ws, connectionData);
              
              // Set up new GigaML session asynchronously
              Promise.resolve().then(async () => {
                try {
                  await this.setupGigaMLSessionAsync(ws, newConnectionId);
                  console.log(`🔧 Emergency session setup completed for ${newConnectionId}`);
                } catch (error) {
                  console.error(`❌ Emergency session setup failed:`, error);
                }
              });
              
              // Send informative message to user
              const infoMessage: ChatMessage = {
                id: `info_${Date.now()}`,
                content: "Reconnecting to AI assistant. Your message will be processed shortly.",
                user: "system",
                role: "assistant",
              };
              
              this.saveMessage(infoMessage);
              this.broadcastMessage({
                type: "add",
                ...infoMessage,
              });
              
              // Continue with the current message processing
              console.log(`🔧 Continuing with new connection setup for message processing`);
              return; // Skip processing this message for now
            } catch (emergencyError) {
              console.error("❌ Emergency recovery failed:", emergencyError);
              
              // Send error message to user
              const errorMessage: ChatMessage = {
                id: `error_${Date.now()}`,
                content: "Connection lost. Please refresh the page to continue.",
                user: "system",
                role: "assistant",
              };
              
              this.saveMessage(errorMessage);
              this.broadcastMessage({
                type: "add",
                ...errorMessage,
              });
              return;
            }
          }
        }
        
        const session = connectionData?.gigamlSession;
        console.log("GigaML session:", session);
        
        if (session && session.status === "active") {
          try {
            console.log(`Sending message to GigaML: ${parsed.content}`);
            await this.sendMessageToGigaML(session.ticketId, parsed.content);
            console.log(`Message sent to GigaML: ${session.ticketId}`);
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
        } else if (!session) {
          console.error("❌ No GigaML session found for connection");
          
          // Send informative error message
          const errorMessage: ChatMessage = {
            id: `error_${Date.now()}`,
            content: "Setting up AI assistant connection. Please wait a moment and try again.",
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

  async handleWebSocketClose(ws: WebSocket): Promise<void> {
    console.log(`🔌❌ WebSocket closing...`);
    const connectionData = this.connections.get(ws);
    console.log(`🔌❌ Connection data:`, connectionData ? JSON.stringify(connectionData, null, 2) : 'null');
    console.log(`🔌❌ Connections before close: ${this.connections.size}`);
    console.log(`🔌❌ Sessions before close: ${this.gigamlSessions.size}`);
    
    if (connectionData?.gigamlSession) {
      const session = connectionData.gigamlSession;
      
      // DO NOT close the GigaML session - let GigaML handle timeouts (1 hour default)
      // Users should be able to leave/refresh and continue the conversation
      console.log(`🔌❌ Keeping GigaML session active for reconnection: ${session.ticketId}`);
      console.log(`🔌❌ Session will timeout automatically on GigaML's side after inactivity`);
      
      // Remove the connection mapping but keep the session in database for reuse
      if (connectionData.id) {
        this.gigamlSessions.delete(connectionData.id);
        console.log(`🧹 Removed connection mapping: ${connectionData.id} -> ${session.ticketId}`);
      }
      
      // DO NOT call unregisterSessionFromRouter - keep session registered for webhooks
      console.log(`🔌❌ Session registry preserved for webhook routing`);
    } else if (connectionData?.id) {
      // Connection existed but had no GigaML session
      console.log(`🔌❌ Connection ${connectionData.id} closed without GigaML session`);
    } else {
      // Connection data was null - this indicates a race condition or early close
      console.log(`🔌❌ Connection closed with no connection data - likely early disconnect`);
    }
    
    // Always remove the WebSocket connection regardless of connection data state
    const wasRemoved = this.connections.delete(ws);
    console.log(`🔌❌ Connection removal successful: ${wasRemoved}`);
    console.log(`🔌❌ Connections after close: ${this.connections.size}`);
    console.log(`🔌❌ Sessions still in memory: ${this.gigamlSessions.size}`);
  }

  private async registerSessionInRouter(ticketId: string, roomId: string): Promise<void> {
    try {
      const routerId = this.env?.Chat?.idFromName?.("webhook-router");
      if (!routerId || !this.env?.Chat) return;
      
      const routerObject = this.env.Chat.get(routerId);
      
      const registerRequest = new Request("https://internal/register-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticketId, roomId }),
      });
      
      await routerObject.fetch(registerRequest);
    } catch (error) {
      console.error("Failed to register session in router:", error);
    }
  }

  private async unregisterSessionFromRouter(ticketId: string): Promise<void> {
    try {
      const routerId = this.env?.Chat?.idFromName?.("webhook-router");
      if (!routerId || !this.env?.Chat) return;
      
      const routerObject = this.env.Chat.get(routerId);
      
      const unregisterRequest = new Request("https://internal/unregister-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticketId }),
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
        console.log(`🔌 WebSocket upgrade request received`);
        const startTime = Date.now();
        
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        // Extract original room ID from request headers if available
        const originalRoomId = request.headers.get("x-original-room-id");
        
        // Set up the connection with a persistent ID BEFORE accepting
        const connectionId = crypto.randomUUID();
        console.log(`🔌 WebSocket connecting with ID: ${connectionId}, roomId: ${originalRoomId}`);
        
        // CRITICAL: Set up connection data immediately and ensure it persists
        const connectionData: { id: string; gigamlSession?: GigaMLSession } = { id: connectionId };
        this.connections.set(server, connectionData);
        
        // Accept the WebSocket AFTER setting up connection data
        this.state.acceptWebSocket(server);
        console.log(`🔌 WebSocket accepted for ${connectionId} after ${Date.now() - startTime}ms`);
        
        // Return the WebSocket response IMMEDIATELY to prevent browser timeout
        const response = new Response(null, {
          status: 101,
          webSocket: client,
        });
        
        // Do ALL async work AFTER returning the response
        // This prevents the browser from canceling the connection
        setTimeout(async () => {
          try {
            console.log(`🔌 Starting post-connection setup for ${connectionId}`);
            
            // Send initial messages
            server.send(JSON.stringify({
              type: "all",
              messages: this.messages,
            } satisfies Message));
            
            // Send connection confirmation message
            server.send(JSON.stringify({
              type: "connection",
              status: "connected",
              connectionId: connectionId,
            }));
            
            console.log(`✅ Initial messages sent to ${connectionId}`);
            
            // Set up GigaML session last
            await this.setupGigaMLSessionAsync(server, connectionId, originalRoomId || undefined);
            console.log(`✅ Complete setup finished for ${connectionId} after ${Date.now() - startTime}ms`);
          } catch (error) {
            console.error(`❌ Post-connection setup failed for ${connectionId}:`, error);
          }
        }, 0);
        
        return response;
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
      console.log("=== GigaML Webhook Received ===");
      console.log("Request URL:", request.url);
      console.log("Request method:", request.method);
      console.log("Request headers:", Object.fromEntries(request.headers.entries()));
      
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
        console.log("Invalid API key - expected:", expectedApiKey.substring(0, 10) + "...");
        console.log("Invalid API key - received:", token.substring(0, 10) + "...");
        return new Response("Unauthorized", { status: 401 });
      }
      
      const body = await request.json() as any;
      console.log("=== Webhook Body ===");
      console.log(JSON.stringify(body, null, 2));
      
      // GigaML uses ticket_id as the session identifier
      const ticketId = body.ticket_id;
      
      if (!ticketId || !body.message) {
        console.log("Invalid payload structure - missing ticket_id or message");
        return new Response("Invalid webhook payload", { status: 400 });
      }
      
      // Find the session
      let targetSession: GigaMLSession | null = null;
      
      for (const [connectionId, session] of this.gigamlSessions.entries()) {
        if (session.ticketId === ticketId) {
          targetSession = session;
          break;
        }
      }
      
      if (!targetSession) {
        const dbResult = this.state.storage.sql
          .exec(`SELECT * FROM gigaml_sessions WHERE ticket_id = ? AND status = 'active'`, ticketId)
          .toArray();
        
        if (dbResult.length === 0) {
          return new Response("Session not found", { status: 404 });
        }
        
        const dbSession = dbResult[0] as any;
        targetSession = {
          ticketId: dbSession.ticket_id,
          userId: dbSession.user_id,
          status: dbSession.status,
          createdAt: dbSession.created_at,
        };
      }
      
      // Extract text content from GigaML message format
      let messageContent: string;
      if (Array.isArray(body.message.content)) {
        // GigaML sends content as an array of objects
        messageContent = body.message.content
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text)
          .join(" ");
      } else if (typeof body.message.content === "string") {
        // Fallback for simple string content
        messageContent = body.message.content;
      } else {
        messageContent = "Assistant response received";
      }

      // Create assistant message
      const assistantMessage: ChatMessage = {
        id: `gigaml_${Date.now()}`,
        content: messageContent,
        user: "Rio Assistant",
        role: "assistant",
      };
      
      this.saveMessage(assistantMessage);
      
      // Check if there are active connections to broadcast to
      const activeConnections = this.connections.size;
      console.log(`📊 Active connections: ${activeConnections}`);
      
      if (activeConnections > 0) {
        this.broadcastMessage({
          type: "add",
          ...assistantMessage,
        });
        console.log(`📤 Broadcasted GigaML response to ${activeConnections} connection(s)`);
      } else {
        console.log(`💾 No active connections - message saved to database for next connection`);
      }
      
      console.log(`🎉 GigaML response processed for session ${ticketId}`);
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
      const body = await request.json() as { ticketId: string; roomId: string };
      
      // Ensure the table exists (don't drop it!)
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS session_registry (ticket_id TEXT PRIMARY KEY, room_id TEXT, created_at TEXT)`
      );
      
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO session_registry (ticket_id, room_id, created_at) VALUES (?, ?, ?)`,
        body.ticketId,
        body.roomId,
        new Date().toISOString()
      );
      
      console.log(`Session registered: ${body.ticketId} -> ${body.roomId}`);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error registering session:", error);
      return new Response("Registration error", { status: 500 });
    }
  }

  async handleSessionUnregistration(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { ticketId: string };
      
      this.state.storage.sql.exec(
        `DELETE FROM session_registry WHERE ticket_id = ?`,
        body.ticketId
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
      console.log("=== Webhook Router: Processing request ===");
      console.log("Router object ID:", this.state.id.name);
      
      const body = await request.json() as any;
      console.log("=== Webhook Router: Body received ===");
      console.log(JSON.stringify(body, null, 2));
      
      // GigaML uses ticket_id as the identifier
      const ticketId = body.ticket_id;
      
      if (!ticketId) {
        console.log("=== Webhook Router: No ticket_id found ===");
        console.log("=== Webhook Router: Available body keys ===", Object.keys(body));
        return new Response("Invalid webhook payload - no ticket_id", { status: 400 });
      }
      
      console.log("=== Webhook Router: Looking up ticket ===", ticketId);
      
      // Ensure the session registry table exists (don't drop it!)
      console.log("=== Webhook Router: Ensuring session registry table exists ===");
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS session_registry (ticket_id TEXT PRIMARY KEY, room_id TEXT, created_at TEXT)`
      );
      
      const sessionRegistry = this.state.storage.sql
        .exec(`SELECT room_id FROM session_registry WHERE ticket_id = ? LIMIT 1`, ticketId)
        .toArray();
      
      console.log("=== Webhook Router: Session registry result ===", sessionRegistry);
      
      if (sessionRegistry.length === 0) {
        console.log(`=== Webhook Router: No session found in registry for ${ticketId} ===`);
        return new Response("Session not found", { status: 404 });
      }
      
      const roomId = (sessionRegistry[0] as any).room_id;
      console.log("=== Webhook Router: Found room ID via ticketId ===", roomId);
      
      const chatId = this.env?.Chat?.idFromName?.(roomId);
      if (!chatId) {
        console.error(`=== Webhook Router: Failed to create chat ID from room ID: ${roomId} ===`);
        return new Response("Invalid room", { status: 400 });
      }
      
      const chatObject = this.env?.Chat?.get?.(chatId);
      if (!chatObject) {
        console.log("=== Webhook Router: Chat object not available ===");
        return new Response("Room not available", { status: 500 });
      }
      
      const targetRequest = new Request(`https://internal/webhook/gigaml`, {
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
      
      console.log(`=== Webhook Router: Routing webhook for ticket ${ticketId} to room ${roomId} ===`);
      const response = await chatObject.fetch(targetRequest);
      console.log("=== Webhook Router: Final response status ===", response.status);
      return response;
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
          console.log("=== Main Worker: GigaML webhook received ===");
          console.log("URL:", request.url);
          console.log("Headers:", Object.fromEntries(request.headers.entries()));
          
          // Clone the request to preserve the original body
          const clonedRequest = request.clone();
          
          // Get raw text first to see exactly what we're receiving
          const bodyText = await clonedRequest.text();
          console.log("=== Main Worker: Raw webhook body ===");
          console.log(bodyText);
          
          let body: any;
          try {
            body = JSON.parse(bodyText);
            console.log("=== Main Worker: Parsed webhook body ===");
            console.log(JSON.stringify(body, null, 2));
          } catch (parseError) {
            console.log("=== Main Worker: Failed to parse JSON ===");
            console.log("Parse error:", parseError);
            return new Response("Invalid JSON payload", { status: 400 });
          }
          
          // Check for ticket_id field - GigaML always uses this
          const ticketId = body.ticket_id;
          
          if (!ticketId) {
            console.log("=== Main Worker: No ticket_id found ===");
            console.log("Available fields:", Object.keys(body));
            return new Response("Invalid webhook payload - no ticket_id", { status: 400 });
          }
          
          console.log("=== Main Worker: Using ticket_id ===", ticketId);
          
          const routerId = env.Chat.idFromName("webhook-router");
          const routerObject = env.Chat.get(routerId);
          
          // Keep the original body with ticket_id
          const normalizedBody = {
            ...body
          };
          
          const routerRequest = new Request(`${url.origin}/route-webhook`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              // Forward authorization if present
              ...(request.headers.get("Authorization") && {
                "Authorization": request.headers.get("Authorization")!
              })
            },
            body: JSON.stringify(normalizedBody),
          });
          
          console.log("=== Main Worker: Routing to webhook router ===");
          const response = await routerObject.fetch(routerRequest);
          console.log("=== Main Worker: Router response status ===", response.status);
          return response;
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
