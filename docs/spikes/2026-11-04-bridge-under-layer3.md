# Spike 2026-11-04: client tool bridge under Layer 3

Question: can the MCP stub of the tool bridge (ADR 0009 Amendment 2) start inside the sandbox-runtime wrapper, so Vibe keeps its tool calls on the launchd instance?

Setup: dev instance on port 4599 from a git worktree under `$HOME` (like the real checkout), claude CLI 2.1.304, macOS, Layer 3 active, request with `tools[]` (`get_weather`, later `get_time`). Worktree and instance removed afterwards.

| Step | Change | Result |
|---|---|---|
| A | bridge built under Layer 3, nothing else | model answers it has no weather tool (no tool_calls) |
| B | stub directory added to the sandbox `allowRead` | `tool_calls`: `get_weather {"city":"Berlin"}` |
| C | stub copied to the temp dir, no sandbox change | no tool_calls until the stub's main guard used the real path (macOS `/var` -> `/private/var`); then tool call, two parallel calls, follow-up turn and plain chat all worked |

Not measured: Linux/bwrap, long sessions, the exact error of step A (not captured). Cause of A (the stub under the denied home) is an inference from B and C.
