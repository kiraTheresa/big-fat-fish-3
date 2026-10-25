# Changelog

All notable changes to **Big Fat Fish** (大肥鱼) are documented here, from a user's perspective.
Versions follow `0.x.y`. Entries are grouped by change type: `feat` (new features), `fix` (bug fixes), `docs`, `chore`.

## [0.9.3] - 2026-10-25

### fix

- **Message splitting now actually works** — the fish was sending multi-part replies as one single bubble. Root cause: the prompt asked the LLM to separate back-to-back messages with `||`, but in real traffic the LLM almost never used `||` and always split with line breaks instead — which the splitter didn't recognize. Now line breaks (single, double, or Windows-style) are treated as split markers just like `||`, and the prompt explicitly tells the fish that each line becomes its own message. Multi-part replies now arrive as several short bubbles, the way a person types.

## [0.9.2] - 2026-10-25

### feat

- **/version command** — check the fish's current version (`/version` → `本鱼版本：0.9.2`). The version source is CHANGELOG.md's top heading, kept in sync with git commit numbers; if unreadable, it safely reports `unknown`.

### fix

- **Persona evolution no longer gets stuck at the size cap** — previously, once a persona file approached the 4 KB limit, every distill patch got rejected and the distiller retried every minute, burning tokens in a loop. Now:
  - The distiller sees each file's real byte budget and is explicitly told to compress rather than grow when above 90% of the cap.
  - Oversized memory patches are auto-trimmed instead of rejected: oldest non-locked entries are dropped first, and `/remember` entries are never touched.
  - An oversized character patch keeps the old character for now while memory still lands — the batch counts as consumed, and the next round retries character with budget feedback.
  - Repeated distill failures (bad JSON, lost locked entries, everything rejected) now back off for 1 hour instead of retrying every 60 seconds.

### refactor

- Command system rebuilt as an extensible registry: each command is a self-contained module (`name` / `adminOnly` / `summary` / `handle`), `/help` is auto-generated from the registry and can no longer drift, and admin permission checks happen in one place. No behavior change to existing commands.

## [0.9.1] - 2026-10-25

### docs

- Introduced this CHANGELOG as the user-facing feature record. Version numbers follow git commit history; `/version` reads the top heading of this file.

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
