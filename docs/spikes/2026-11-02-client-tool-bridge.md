# Spike: client tool calls through an MCP stub (claude CLI 2.1.304)

- **Date:** 2026-11-02
- **Question:** Can OLP hand an OpenAI `tools[]` list to the `claude` CLI, receive the model's tool call, and give it back to the client without the CLI running the tool?
- **Used by:** ADR 0002 Amendment 10, ADR 0003 Amendment 4, ADR 0004 Amendment 7, ADR 0005 Amendment 9, ADR 0009 Amendment 2.
- **Environment:** macOS, `claude` 2.1.304 (Claude Code), model alias `sonnet`, subscription auth. Scratch files lived in `/tmp/olp-spike/`; they are not part of the repo because the raw transcripts contain the operator's local hook output.

## Setup

A dependency-free MCP stdio server (about 25 lines, JSON-RPC over stdin/stdout) answers `initialize`, `tools/list` with one tool `get_weather(city)`, and `tools/call` with a fixed text. Every incoming line is appended to a log file. The CLI was started as:

```
claude -p "<prompt>" \
  --mcp-config <stub.json> --strict-mcp-config \
  --tools "" --allowedTools "mcp__stub__get_weather" \
  --system-prompt "You are accessed via a proxy. Use the provided tools when useful." \
  --output-format stream-json --verbose --model sonnet
```

(OLP's production spawn does not use `-p`; the prompt arrives on stdin, see ADR 0009 Amendment 1. `-p` was used here for the spike only. The event stream is the same.)

## Observations

| # | Observation | Evidence |
|---|---|---|
| 1 | With `--strict-mcp-config` and `--tools ""` the only tool the model sees is the stub's. | `system/init` event: `tools: ["mcp__stub__get_weather"]`, `mcp_servers: [{"name":"stub","status":"connected","source":"dynamic"}]`. |
| 2 | The tool call appears on stdout as an `assistant` event with a `tool_use` block **before** its result exists. | Event order: `system/init` → `assistant{tool_use name=mcp__stub__get_weather input={"city":"Berlin"}}` → `user{tool_result}` → `assistant{text}` → `result`. |
| 3 | The stub receives `tools/call` with the same id (`_meta."claudecode/toolUseId"`). | Stub log line `CALL {"name":"get_weather","arguments":{"city":"Berlin"},"_meta":{"claudecode/toolUseId":"toolu_…"}}`. |
| 4 | Parallel calls arrive as **separate** `assistant` events that share one `message.id`, back to back, both before any `tool_result`. | Prompt asking for Berlin and München: events 9 and 10 are `assistant` with the same `msg_…` id, each carrying one `tool_use`; events 12 and 13 are the two `tool_result`s. |
| 5 | Replaying history as `--input-format stream-json` (`assistant{tool_use}` + `user{tool_result}`) does **not** work: the CLI ignores the injected assistant turn, the model reports that the first call returned nothing and calls the tool again. | The stub log shows a fresh `CALL` after the replayed history. |
| 6 | Rendering the earlier call and its result as text in the prompt (`[Tool Result get_weather] …`, the form `irToAnthropic` already produces) works: the model answers from the supplied result and does not call the tool again. | Model answer "7 °C bei Regen" (the value from the prompt, not from the stub); stub log has no `CALL`. |
| 7 | `result.usage` still carries `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` after a tool round inside one run. | `result` event keys. |

## Consequences used by the ADRs

- The bridge only needs the model's decision, so OLP can stop the CLI at the `tool_use` event; the tool runs on the client (observations 2, 3).
- Several calls in one answer have to be collected from consecutive events of one `message.id`; OLP cannot know that no further event follows, so it needs a short idle window (observation 4).
- The follow-up turn stays text in the prompt (observations 5, 6).
- An aborted run delivers no `result` event, so no token counts (observation 7). The `stream_options.include_usage` chunk then falls back to the character estimate (`lib/ir/usage.mjs`).

## Not covered

- Whether a sandboxed spawn (ADR 0014 Layer 3) can start the stub (path readable, `node` on `PATH`).
- Long agent sessions with many tool rounds in text form.
- The idle window length (no timing measurement was taken beyond "events 9 and 10 are adjacent").
