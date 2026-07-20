# pi-telegram-notify

A Pi package that sends Telegram notifications for `ask_user` prompts and when a Pi agent becomes idle, while still bundling the interactive `ask_user` tool.

## Demo

![ask_user demo](./media/ask-user-demo.gif)

High-quality video: [ask-user-demo.mp4](./media/ask-user-demo.mp4)

## Features

- Searchable single-select option lists with wrapped titles and descriptions
- Responsive split-pane details preview on wide terminals with single-column fallback on narrow terminals
- Multi-select option lists
- Optional freeform responses
- User-toggleable extra context on structured selections
- Context display support
- Configurable display mode: `overlay` (modal, default) or `inline` (rendered directly in the flow)
- Runtime overlay toggle: press the configured overlay-toggle key (`alt+o` by default, configurable per call or via env var) while the prompt is open to temporarily hide/show the popup so you can read prior agent output, then press it again to bring it back
- Local Pi notification every time an `ask_user` prompt opens
- Herdr integration: reports the root agent as `blocked` while an `ask_user` prompt is open and restores its normal state when the prompt closes
- Telegram notifications for `ask_user` prompts, delayed by 60 seconds so quick local answers suppress the Telegram message
- A/B/C-style Telegram quick-reply buttons and reply-to-message answers for prompts
- Telegram idle notifications on `agent_end`, also delayed by 60 seconds and cancelled if the user responds first
- Pi-TUI-aligned keybinding and editor behavior
- Custom TUI rendering for tool calls and results
- System prompt integration via `promptSnippet` and `promptGuidelines`
- Optional timeout for auto-dismiss in both overlay and fallback input modes
- Structured `details` on all results for session state reconstruction
- Graceful fallback when interactive UI is unavailable
- Bundled `ask-user` skill for mandatory decision-gating in high-stakes or ambiguous tasks

## Bundled skill: `ask-user`

This package now ships a skill at `skills/ask-user/SKILL.md` that nudges/mandates the agent to use `ask_user` when:

- architectural trade-offs are high impact
- requirements are ambiguous or conflicting
- assumptions would materially change implementation

The skill follows a "decision handshake" flow:

1. Gather evidence and summarize context
2. Ask one focused question via `ask_user`
3. Wait for explicit user choice
4. Confirm the decision, then proceed

See the bundled skill reference under `skills/ask-user/references/`.

## Install

```bash
pi install npm:pi-telegram-notify
```

## Tool name

The registered tool name is:

- `ask_user`

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | *required* | The question to ask the user |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string \| {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a "Type something" freeform option |
| `allowComment` | `boolean?` | `false` | Expose a user-toggleable extra-context option in the custom UI (`ctrl+g` or the toggle row) and collect an optional comment in fallback dialogs |
| `displayMode` | `"overlay" \| "inline"?` | env var or `"overlay"` | Controls custom UI rendering: `overlay` shows the centered modal (current behavior), `inline` renders without overlay framing |
| `overlayToggleKey` | `string?` | env var or `"alt+o"` | Shortcut for hiding/showing the overlay popup (overlay mode only). Pi-TUI key spec, e.g. `"alt+o"`, `"ctrl+shift+h"`. Pass `"off"` to disable. |
| `commentToggleKey` | `string?` | env var or `"ctrl+g"` | Shortcut for toggling the optional comment/extra-context row when `allowComment: true`. Pass `"off"` to disable. |
| `timeout` | `number?` | — | Auto-dismiss after N ms and return `null` if the prompt times out |

## Example usage shape

```json
{
  "question": "Which option should we use?",
  "context": "We are choosing a deploy target.",
  "options": [
    "staging",
    { "title": "production", "description": "Customer-facing" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "allowComment": true,
  "displayMode": "inline"
}
```

`displayMode: "inline"` uses the same interaction logic but skips overlay mode when calling `ctx.ui.custom(...)`. RPC/headless fallback behavior is unchanged.

## Personal preferences via environment variables

Configure your defaults globally by setting these in your shell profile (`~/.zshrc`, `~/.bash_profile`, etc.):

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### Display mode

Effective order:

1. Per-call `displayMode` parameter (if provided)
2. `PI_ASK_USER_DISPLAY_MODE` (if set to `"overlay"` or `"inline"`)
3. Fallback default: `"overlay"`

Unrecognised values are silently ignored and fall back to `"overlay"`.

### Shortcuts

Effective order for both `overlayToggleKey` and `commentToggleKey`:

1. Per-call parameter (if provided)
2. Matching env var (`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`)
3. Built-in defaults: `alt+o` and `ctrl+g`

Pass `"off"`, `"none"`, or `"disabled"` (at any level) to disable the shortcut entirely. Invalid specs are silently dropped and the next source is used. Specs follow the Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) format: `[mod+]...key` where modifiers are `ctrl`, `shift`, `alt`, `super`, in any order, joined by `+` (e.g. `ctrl+g`, `alt+shift+x`, `escape`, `tab`).

### Availability timeouts

By default, `ask_user` waits up to 10 minutes. The first timeout marks the user
as away globally; subsequent questions from any Pi session wait one minute.
Interactive/RPC input, local answers, Telegram answers, and manual cancellation
reset availability to normal. Extension-generated input, including automatic
goal continuations, does not reset it.

Configure the policy in `~/.pi/agent/settings.json`:

```json
{
  "askUser": {
    "availability": {
      "enabled": true,
      "normalTimeoutMs": 600000,
      "awayTimeoutMs": 60000
    }
  }
}
```

An explicit per-call `timeout` can shorten, but never extend, the configured
limit. Set `enabled` to `false` to restore the old behavior where only explicit
per-call timeouts apply. Availability is shared through
`~/.pi/agent/ask-user-presence.json` with atomic cross-session updates.

Commands:

- `/ask-status` — show the current mode and configured limits.
- `/ask-away` — manually use the shorter away timeout.
- `/ask-reset` — return to normal mode.

On timeout, the tool tells the agent not to repeat the question immediately: it
must choose a safe/recommended option and state the assumption, or call
`pause_goal` when an active goal cannot proceed safely without the user. This
prevents goal auto-continuation from remaining blocked forever.

### Telegram notifications

Add top-level `telegram` settings to `~/.pi/agent/settings.json`:

```json
{
  "telegram": {
    "botToken": "123456:replace-with-your-bot-token",
    "chatId": "123456789"
  }
}
```

For compatibility with earlier `pi-ask-user` installations, the namespaced
form `piAskUser.telegram` is also accepted. If both forms exist, the top-level
`telegram` settings take precedence.

When both settings are present, `pi-telegram-notify` sends:

- `ask_user` prompt notifications after a 60-second grace period. If the active availability timeout is too short for that delay, Telegram delivery is accelerated automatically. If the prompt is answered locally first, no Telegram message is sent.
- Agent idle notifications on Pi's `agent_end` event after the same 60-second grace period. If the user responds, a new turn starts, or async subagents are still running, no Telegram message is sent. The idle notification is deferred until the final async run completes, and subagent child processes never send their own Telegram notifications.

The `ask_user` Telegram message is compact, HTML-escaped, and uses inline quick-reply buttons labelled `A`, `B`, `C`, etc.; longer context and option descriptions are in a collapsible details section. The internal request id is hidden in Telegram `callback_data`, not printed in the message. Pressing an option button answers the matching prompt. You can also reply to the Telegram message with an option letter/title; for multi-select prompts, reply with comma-separated letters such as `A,C`. If `allowComment` is enabled, include a comment as `A - your comment` (or `A,C - your comment`). If `allowFreeform` is enabled, Telegram also shows a `Custom answer` button that prompts you to reply with custom text.

When the bot reports `has_topics_enabled`, each Pi session gets one private-chat forum topic, created lazily on its first notification. Topics are named `repository · session-name`, or `repository · short-session-id` when unnamed; worktree and parent-folder names are never used. Resuming a session reuses its topic. Older repository/worktree topics remain historical and are not reused. Text sent in an active session topic is delivered to that Pi session (immediately when idle, otherwise as a follow-up); ask_user replies keep precedence. Historical/inactive topics receive an inactive notice. Only text is supported. Configure private-chat forum topics in BotFather before enabling this mode; unavailable/deleted topics fall back to the general chat.

Multiple prompts can be open at the same time: each Telegram callback/reply is correlated by hidden request id and Telegram message id so the answer returns to the correct `ask_user` call. After an answer is accepted, the original Telegram prompt is edited to show `✅ Answered` and the selected/custom response, with quick-reply buttons removed. Idle notifications that were already sent are edited to show that the session resumed. Coordination state is shared through a token-hashed temp directory with a single polling lock, so separate Pi sessions using the same bot/chat do not race each other with competing `getUpdates` offsets. If either setting is missing, Telegram integration is disabled and the local Pi UI continues to work normally. Tokens are only read from the settings file and are not printed in warnings.

## Controls

While an `ask_user` prompt is open:

| Key | Action |
|-----|--------|
| `alt+o` (configurable via `overlayToggleKey`) | Hide/show the overlay popup so you can read the agent's prior output. Available in `overlay` mode only. The first time you hide it, a notification reminds you which key brings it back. |
| `ctrl+g` (configurable via `commentToggleKey`) | Toggle the optional comment/extra-context row (when `allowComment: true`). |
| `enter` | Confirm the focused option, submit a freeform response, or submit/skip an optional comment. |
| `esc` | Clear the search filter, exit freeform/comment mode, or cancel the prompt. |
| `↑` / `↓`, `ctrl+k` / `ctrl+j` | Navigate options. `ctrl+k` / `ctrl+j` (vim-style) work while typing in searchable prompts without disturbing the filter. |

If you prefer never to see the overlay, set `displayMode: "inline"` per call or `PI_ASK_USER_DISPLAY_MODE=inline` globally.

## Result details

All tool results include a structured `details` object for rendering and session state reconstruction:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
  timedOut?: boolean;
  presenceMode?: "normal" | "away";
  timeoutMs?: number;
}
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
