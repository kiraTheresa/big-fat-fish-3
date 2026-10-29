# Changelog

All notable changes to **Big Fat Fish** (大肥鱼) are documented here, from a user's perspective.
Versions follow `0.x.y`. Entries are grouped by change type: `feat` (new features), `fix` (bug fixes), `docs`, `chore`.

Documentation reconciliation on 2026-10-26: missing entries from `0.10.0` through `0.11.0` were restored from the corresponding commits, and current behavior boundaries were clarified. The group-command entry previously labeled `0.9.4` belongs to `0.10.1`. This reconciliation does not introduce a new feature release.

## [Unreleased]

### feat

- Session-scoped meme collections with explicit command or natural-language saving, local search and native OneBot image/mface/face replay. Preserve animation bytes and native references, deduplicate collections, support rename/disable/re-enable, and confirm sends through the existing queue. Model use is limited to searched candidates and one send attempt per turn; Prompt tests never send memes to QQ.

- Prompt-page workbench and relaxed appearance presets, with a one-click switch that preserves draft/test state and remembers only the browser appearance preference.

- Natural-language drawing and memory tools after the existing wake-up rules, with server-bound scope, argument checks, bounded tool loops and per-turn duplicate protection.
- Prompt console with layered editing, explainable history filtering, request JSON, isolated session snapshots, real-model tests, manual review, revision-bound publishing and rollback through drafts. Initial persona changes apply only to new/reset sessions.

- Receive and persist all OneBot 11 standard event families and message segments, including CQ strings and unknown extensions. Newly supported types are receipt-only.
- Local management console with a liquid-glass interface: runtime health, event inbox, validated live configuration, QQ roles, durable jobs, structured logs and model usage. Admin APIs require a separate token.
- Shared atomic persistence, single-process data-directory guard, recoverable interval/once jobs and daily observation retention.
- Count chat, vision, drawing and distillation API attempts, including failures and unknown usage; enforce feature switches and daily request limits, with a reported-token threshold.

### fix

- Recover the runtime lock across host/container switches using a renewable shared-filesystem lease; active instances stay exclusive, while crashed owners expire after 30 seconds regardless of hostname or PID reuse.

- Remove the drawing QQ whitelist; drawing is public by default while group @ addressing remains required.
- Preserve sanitized provider error details for failed image/chat requests. The earlier real image HTTP 400 still needs a provider response to diagnose.
- Remove a test dependency on an ignored local IDE spec; repository tests now carry their own seed assertions.

## [0.11.0] - 2026-10-25

### feat

- **Teach the fish a personality trait** — `/character <text>` appends a speaking style or personality instruction to the current conversation's character file without a model call. Like `/remember`, it is available to ordinary users; group commands still require @. The distiller now checks that both character instructions and explicit memories from its input are preserved. Explicit teaching retains the newest entry and may evict older taught entries when space runs out.

## [0.10.2] - 2026-10-25

### feat

- **Image understanding in chat** — a triggered message with text can include one image. In groups, a text-only follow-up can also use a recent image from the same sender within the configured window (120 seconds by default, searched in the last 20 messages). The fish sends a short acknowledgement before downloading the image into memory and calling the vision model. Download or vision failures fall back to text chat. Image-only messages and private-chat history lookup are not supported yet; set `DEEPSEEK_VISION_MODEL` to an empty value to disable vision.

## [0.10.1] - 2026-10-25

### feat

- **Group commands now need @ first** — in group chats, commands only take effect when the message @-mentions the fish (e.g. `@大肥鱼 /help`); without @, the fish stays quiet no matter what the message starts with. This ends three kinds of noise: replies to casual messages that merely start with `/` ("unknown command"), permission errors when non-admins poke admin commands, and — in groups with several bots — every prefix-matching bot answering the same bare command at once. Private chats are unchanged (`/help` works directly); `/draw` follows the same rule.

## [0.10.0] - 2026-10-25

### feat

- **Text-to-image generation** — `/draw <prompt>` acknowledges the request, calls a configurable image generation endpoint, and sends the resulting image through the shared queue. Both group and private chats require the sender to be in `DRAW_WHITELIST_QQ`; an empty list denies all users. The feature is disabled without `IMAGE_API_KEY`. Conversation history keeps a text placeholder for the generated image; the image itself is not saved by the Bot.

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
- **Locked memories** — `/remember` entries in the distiller's input are checked against its output. A patch that fails to retain those entries is rejected; this protects the input snapshot, rather than providing a transaction against concurrent edits.
- **Picky distiller** — the offline distiller now only keeps what matters (user preferences, identity facts, commitments) and ignores small talk, moods and pleasantries. Memories are written one entry per line.
- **Context budget** — a configurable 12,000-byte budget reserves space for the system prompt and keeps the most recent continuous history that fits. It trims history only: the system prompt, current input and image payload are not truncated, so this is not a hard limit on the entire request.
- **Behavior switches without code** — a new `config.json` controls trigger conditions, reply pacing and history budget. A missing, unreadable or invalid JSON file falls back to defaults; nested field validation is not comprehensive. Changes require a Bot restart. See `config.example.json`.

### docs

- STATE.md feature inventory rewritten to cover the new pipeline.

## [0.8.0] - 2026-10-25

### feat

- **Self-evolving persona** — the fish maintains a per-conversation character (`character.md`) and fact memory (`memory.md`), incrementally evolved by a background distiller triggered after 10 minutes of silence or 50 new messages. Its prompt instructs the model to preserve the core identity ("silly big fat fish, sincere, mascot"); this is not a programmatic guarantee. Background distillation still calls the remote model.
- **Command system** — `/help`, `/status`, `/persona`, `/persona reset`, `/memory`, `/remember`, `/reset`, `/history`. Admin-only commands (in groups) are restricted to the `ADMIN_QQ` whitelist.
- **/remember** — teach the fish a fact instantly, in your own words, at zero LLM cost.
- **/reset** — admin clears the conversation context and starts fresh (history files are kept, only the visible window resets).
- **Usage tracking** — returned token usage (including cache hits) is recorded for successful chat and applied distillation paths, then summarized via `/status`. Failed or rejected distillation, retries and image generation are not fully accounted for; the summary is not a complete billing record.

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
