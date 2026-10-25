# Changelog

All notable changes to **Big Fat Fish** (大肥鱼) are documented here, from a user's perspective.
Versions follow `0.x.y`. Entries are grouped by change type: `feat` (new features), `fix` (bug fixes), `docs`, `chore`.

## [0.9.0] - 2026-10-25

### feat

- **Respond without @** — in group chats, the fish now answers when you call its name ("大肥鱼" / "肥鱼", alias list configurable) or quote-reply to any of its messages. @ still works; all three trigger conditions can be toggled independently.
- **Human-paced replies** — before answering, the fish "thinks" for a random 2–8 seconds; long replies are split into several short back-to-back messages, the way a person types. One logical reply is still stored as one entry, so conversation memory is not fragmented.
- **Quoted replies** — in group chats, the fish's first message quotes the message that triggered it, so multi-person conversations stay easy to follow. (Off in private chats.)
- **Scene awareness** — the fish now knows the current time, whether it is in a group or a private chat, and how long the conversation has been silent (from "just now" up to "N days ago"), and adapts its tone accordingly.
- **Scene-based behavior rules** — more restrained and never spammy in groups; more open to chatting at length in private chats.
- **Locked memories** — anything taught via `/remember` is now locked: the auto-distiller can never drop or rewrite it. A patch that loses a locked entry is rejected and retried.
- **Picky distiller** — the offline distiller now only keeps what matters (user preferences, identity facts, commitments) and ignores small talk, moods and pleasantries. Memories are written one entry per line.
- **Context budget** — persona + memory + history are capped at 12,000 bytes (configurable); when over budget, the oldest history is trimmed first, always keeping the most recent context.
- **Behavior switches without code** — a new `config.json` controls all behavior (trigger conditions, reply pacing, context budget). Missing or broken file safely falls back to defaults. See `config.example.json`.

### docs

- STATE.md feature inventory rewritten to cover the new pipeline.

## [0.8.0] - 2026-10-25

### feat

- **Self-evolving persona** — the fish maintains a per-conversation character (`character.md`) and fact memory (`memory.md`), incrementally evolved by an offline distiller triggered after 10 minutes of silence or 50 new messages. Core identity ("silly big fat fish, sincere, mascot") can never be overwritten.
- **Command system** — `/help`, `/status`, `/persona`, `/persona reset`, `/memory`, `/remember`, `/reset`, `/history`. Admin-only commands (in groups) are restricted to the `ADMIN_QQ` whitelist.
- **/remember** — teach the fish a fact instantly, in your own words, at zero LLM cost.
- **/reset** — admin clears the conversation context and starts fresh (history files are kept, only the visible window resets).
- **Usage tracking** — every LLM call's token usage (including cache hits) is recorded and summarized via `/status`.

### fix

- Fixed session "amnesia": OneBot event timestamps are second-based while internal timers are millisecond-based; the mismatch caused the reset watermark to filter out all history. Both sides now use a consistent scale.

## [0.7.0] - 2026-10-25

### feat

- **AI chat** — the fish can actually talk. Private messages are always answered; group messages are answered when the fish is @-mentioned (@-all does not count).
- **Conversation context** — each chat carries the last 20 messages, with the fish's own replies included.
- **Spam protection** — a per-session 5-second cooldown; empty-content messages are ignored.
- **Graceful failures** — a fixed fallback message when the LLM is unavailable.

## [0.6.1] - 2026-10-25

### feat

- **ping → pong** — send "ping" and the fish replies "pong", to verify the pipeline end to end.

## [0.6.0] - 2026-10-24

### feat

- **Bot core pipeline** — OneBot 11 WebSocket connection to NapCat with Bearer-token auth and auto-reconnect (5s), event dispatch with session keys (`g-{group_id}` / `p-{user_id}`), and a unified outgoing queue throttled to one message per second as the single risk-control gate.
- Message storage: every inbound and outbound message is appended to per-session JSONL files, without ever blocking the main pipeline.

## [0.5.0] and earlier - 2026-10-24

Design phase: direction docs, NapCat protocol inventory, layered bot-core architecture, and storage tech selection. No user-facing features yet.
