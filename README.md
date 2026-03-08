# OpenClaw Coordination Hub

Real-time coordination layer for OpenClaw sub-agent orchestration.

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

## Architecture

See `TECHNICAL_SPEC.md` for detailed architecture docs.
