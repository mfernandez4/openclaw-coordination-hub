# Telegram Handoff Flow

This document describes how to seamlessly continue conversations across channels (web UI → Telegram).

## Concept

The coordination hub's memory-bridge persists conversation context to Redis. When you switch from web UI to Telegram, the new session reads that context and resumes seamlessly.

## Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Web UI Session │────▶│  Memory Bridge  │────▶│     Redis      │
│  (main)         │     │  (write)        │     │  (persist)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Telegram       │◀────│  Memory Bridge  │◀────│     Redis      │
│  Session        │     │  (read)         │     │  (restore)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Usage

### Before handoff (in Web UI)

1. Let me know you're switching: "k2so, heading to Telegram"
2. I write current context to memory-bridge:
   - Active task state
   - Recent conversation summary
   - Files being worked on

### On Telegram

1. Start session normally
2. I read from memory-bridge first
3. Resume with context: "Continuing from where we left off..."

## Context Format

```json
{
  "sessionId": "abc123",
  "lastTask": "verify redis connectivity",
  "lastResult": "PASS - redis:6379 reachable",
  "filesInProgress": ["TOOLS.md", "memory/2026-03-08.md"],
  "summary": "We were testing the coordination hub..."
}
```

## Evolving Pattern

This flow will evolve as we use it. Document changes here as patterns emerge.

## Commands

- `hub-task.js --status` — check pending tasks in queue
- `hub-task.js -t "do something"` — enqueue from any session
