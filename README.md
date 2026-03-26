# openclaw-coordination-hub

Real-time coordination layer for OpenClaw sub-agents.

## Purpose

Provide real-time communication and coordination for OpenClaw's sub-agent ecosystem. Enables:
- Agent-to-agent messaging via Redis pub/sub
- Task queue management for multi-agent workflows
- A2A (Agent-to-Agent) protocol support for modality-agnostic file sharing
- Integration with `openclaw-memory-system-v1` for persistence

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                  Coordination Hub                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐    │
│  │ Redis Pub/Sub│  │ Task Queue  │  │  A2A Adapter    │    │
│  │ (Real-time)  │  │ (Workflows) │  │ (File sharing)  │    │
│  └─────────────┘  └─────────────┘  └─────────────────┘    │
│                           │                                 │
│                    ┌──────▼──────┐                         │
│                    │ Mem0 Adapter│                         │
│                    │ (Persistence)│                         │
│                    └──────┬──────┘                         │
└───────────────────────────│─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              openclaw-memory-system-v1                       │
│         (File-based memory, nightly review)                  │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Redis Pub/Sub Layer
- Agent status tracking (online/busy/idle)
- Real-time event broadcasting
- Channels: `agents:events`, `tasks:events`, `workflows:events`

### 2. Task Queue
- Structured task management
- Dependencies support
- Progress tracking

### 3. A2A Adapter
- Agent-to-Agent protocol support
- Modality-agnostic file sharing (images, code, documents)
- JSON-RPC based messaging

### 4. Mem0 Integration
- Persistent memory for agent interactions
- Semantic search over conversation history
- Graph relationships between agents

## Overview

A lightweight Node.js service providing:
- Redis-backed pub/sub for real-time agent messaging
- Task queue for distributed job processing
- A2A (Agent-to-Agent) protocol adapter
- Memory bridge to OpenClaw's memory system
- Optional Mem0 integration (disabled by default)

## Quick Start

```bash
npm install
npm start
```

## Configuration

Set environment variables:
- `REDIS_HOST` - Redis host (default: redis)
- `REDIS_PORT` - Redis port (default: 6379)
- `MEM0_ENABLED` - Enable Mem0 integration (default: false)

## Related Projects

- [openclaw-memory-system-v1](https://github.com/k2so-bot/openclaw-memory-system-v1) — Persistent file-based memory
- [openclaw-orchestrator-first-v1](https://github.com/k2so-bot/openclaw-orchestrator-first-v1) — Agent roster and orchestration patterns

## Status

Initial scaffold. Implementation in progress.
---
