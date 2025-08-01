# Durable Chat App with GigaML AI Integration

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/durable-chat-template)

![Template Preview](https://imagedelivery.net/wSMYJvS3Xw-n339CbDyDIA/da00d330-9a3b-40a2-e6df-b08813fb7200/public)

<!-- dash-content-start -->

With this template, you can deploy your own chat app to converse with other users in real-time, enhanced with **GigaML AI assistant integration**. Going to the [demo website](https://durable-chat-template.templates.workers.dev) puts you into a unique chat room based on the ID in the url. Share that ID with others to chat with them!

This chat app now includes an AI assistant powered by GigaML that automatically responds to user messages. The AI uses the Rio Text Agent ID: `agent_template_8c309492-fbc9-414e-a44a-22be19bee601`.

This is powered by [Durable Objects](https://developers.cloudflare.com/durable-objects/), [PartyKit](https://www.partykit.io/), and [GigaML](https://gigaml.com/).

## 🤖 AI Features

- **Room-Scoped AI Responses**: Each chat room has its own AI assistant conversation
- **Automatic AI Integration**: Messages are automatically sent to the GigaML AI assistant
- **Real-time Responses**: AI responses appear instantly in the specific chat room
- **Session Management**: Each room maintains independent AI conversation sessions
- **Privacy**: AI conversations are isolated per room - responses only go to room participants
- **Error Handling**: Graceful handling of AI service interruptions

## How It Works

Users are assigned their own chat room when they first visit the page, and can talk to others by sharing their room URL. When someone joins the chat room, a WebSocket connection is opened with a [Durable Object](https://developers.cloudflare.com/durable-objects/) that stores and synchronizes the chat history.

The Durable Object instance that manages the chat room runs in one location, and handles all incoming WebSocket connections. Chat messages are stored and retrieved using the [Durable Object SQL Storage API](https://developers.cloudflare.com/durable-objects/api/sql-storage/). When a new user joins the room, the existing chat history is retrieved from the Durable Object for that room. When a user sends a chat message, the message is stored in the Durable Object for that room and broadcast to all other users in that room via WebSocket connection. This template uses the [PartyKit Server API](https://docs.partykit.io/reference/partyserver-api/) to simplify the connection management logic, but could also be implemented using Durable Objects on their own.

<!-- dash-content-end -->

## Getting Started

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/pages/get-started/c3/) (the `create-cloudflare` CLI):

```
npm create cloudflare@latest -- --template=cloudflare/templates/durable-chat-template
```

A live public deployment of this template is available at [https://durable-chat-template.templates.workers.dev](https://durable-chat-template.templates.workers.dev)

## Setup Steps

1. Install the project dependencies with a package manager of your choice:

   ```bash
   npm install
   ```

2. **GigaML Integration Setup** (New):

   ```bash
   # Quick setup with the provided script
   ./setup-gigaml.sh

   # Or manual setup:
   wrangler secret put GIGAML_API_KEY
   ```

3. Deploy the project!

   ```bash
   npx wrangler deploy
   ```

4. **Configure GigaML Webhook** (New):
   - In your GigaML dashboard, set the webhook URL to: `https://your-deployed-app.workers.dev/webhook/gigaml`
   - The AI assistant will automatically respond to user messages

## 📚 Documentation

- **[GigaML Integration Guide](./GIGAML_INTEGRATION.md)** - Detailed setup and configuration
- **[Environment Variables](./.env.example)** - Required configuration values
