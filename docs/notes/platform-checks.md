# Platform checks (Task 0 spike)

Date: 2026-10-30. Claude Code 2.1.309 on Windows 11, Node 24. Sources: the hooks reference
(`https://code.claude.com/docs/en/hooks.md`, read in full), the plugin dependencies page
(`https://code.claude.com/docs/en/plugin-dependencies.md`), a real `claude -p` run, and a real
session transcript.

## Summary

| # | Question | Answer |
| - | -------- | ------ |
| 1a | `PreCompact` input carries `trigger` = `manual`/`auto` | Yes. Also carries `custom_instructions` (string or `null`). |
| 1b | `PreCompact` and `Stop` accept `systemMessage` and `additionalContext` | **Stop: yes to both. PreCompact: no to both.** PreCompact discards `systemMessage`; `additionalContext` is not an output field there. |
| 1c | `SessionStart` input carries `source` = `startup\|resume\|clear\|compact` | Yes, plus a fifth value `fork`. |
| 1d | `PreToolUse` `permissionDecision` shape | `hookSpecificOutput.permissionDecision` (nested, not top-level). See below. |
| 2 | Namespaced skill preload and cross-marketplace dependency | Preload resolved (verified). Dependency loaded with no error when the target is already installed and enabled. The not-installed case is unverified (see below). |
| 3 | Transcript field names | Recorded below. Fixture: `tests/fixtures/transcript.sample.jsonl`. |

Design consequences:

- The PreCompact hook cannot inject context or show a message. Its only effect is
  `decision: "block"` or exit 2 (blocks compaction). Anything the plugin wants to survive a
  compaction must be re-injected by the `SessionStart` hook when `source == "compact"`. A PreCompact
  hook may still write state to `${CLAUDE_PLUGIN_DATA}` as a side effect, so the SessionStart
  re-injection has something to read.
- A `Stop` hook has two ways to continue the turn: `decision: "block"` + `reason` (shown as a hook
  error) or `hookSpecificOutput.additionalContext` (shown as `Stop hook feedback`, no error). Both
  count toward the 8-consecutive-continuation cap, so every Stop hook must check `stop_hook_active`.
- Context caps in the platform: `additionalContext`, `systemMessage` and plain stdout are each capped
  at 10,000 characters (over that, Claude Code writes the text to a file and passes a 2,000-char
  preview). Our `MAX_CONTEXT_CHARS = 6000` is under it.

## 1. Hook events and payload fields

`claude --help` lists no hook flags; hooks come from settings or a plugin's `hooks/hooks.json`.
The doc lists 33 events: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse,
PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure,
TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged,
WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch,
Elicitation, ElicitationResult, SessionEnd. All five events the plugin uses exist (SessionStart,
SubagentStart, PreToolUse, PreCompact, Stop).

Common input fields (every event): `session_id`, `transcript_path`, `cwd`, `hook_event_name`; the
table also lists `prompt_id`, `scratchpad_dir`, `permission_mode`. Hook input arrives as JSON on
stdin.

### (a) PreCompact input: `trigger`

> "In addition to the common input fields, PreCompact hooks receive `trigger` and
> `custom_instructions`. For `manual`, `custom_instructions` contains what the user passes into
> `/compact` and is `null` when they pass nothing. For `auto`, `custom_instructions` is `null`."

```json
{ "session_id": "abc123", "transcript_path": "...", "cwd": "...",
  "hook_event_name": "PreCompact", "trigger": "manual", "custom_instructions": null }
```

Matcher table: `manual` = `/compact`; `auto` = auto-compact at the window limit, and idle compaction.
Verified from docs only (not run).

### (b) systemMessage / additionalContext on PreCompact and Stop

Universal output fields (`continue`, `stopReason`, `suppressOutput`, `systemMessage`): "Every event
accepts them, but some events discard them or deliver `systemMessage` somewhere other than the
transcript. Each event's section says so."

PreCompact:

> "Claude Code discards a PreCompact hook's `systemMessage` and `continue` fields."

PreCompact decision control is only top-level `decision: "block"` (+ `reason`) or exit 2:

> "Exit with code 2 to block compaction. ... You can also block by returning JSON with
> `"decision": "block"`."

`additionalContext` is not listed for PreCompact. The decision-control table row is
"UserPromptSubmit, ..., Stop, SubagentStop, ConfigChange, PreCompact | Top-level `decision` |
`decision: "block"`, `reason`. Stop and SubagentStop also accept
`hookSpecificOutput.additionalContext`". So `additionalContext` on PreCompact is not accepted
(unverified at runtime, but the docs say where it is accepted and PreCompact is not on that list).

Stop:

> "Stop and SubagentStop also accept `hookSpecificOutput.additionalContext` for non-error feedback
> that continues the conversation."

```json
{ "hookSpecificOutput": { "hookEventName": "Stop",
  "additionalContext": "Please run the test suite before finishing" } }
```

Stop's section does not say `systemMessage` is discarded (unlike PreCompact, Notification,
ConfigChange, SessionEnd, Setup, InstructionsLoaded, WorktreeRemove), so the universal field
applies: `{"systemMessage": "..."}` is shown to the user. Docs-only; not run.

Events that accept `hookSpecificOutput.additionalContext` per the "Add context for Claude" list:
SessionStart, SubagentStart, UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse,
PostToolUseFailure, PostToolBatch, Stop, SubagentStop, PostModelSwitch. For SessionStart (and
UserPromptSubmit, UserPromptExpansion, PostModelSwitch) plain-text stdout on exit 0 is also added as
context. `Setup` discards everything, including `additionalContext`.

### Stop input: `stop_hook_active`

> "Stop hooks receive `stop_hook_active`, `last_assistant_message`, `background_tasks`, and
> `session_crons`. The `stop_hook_active` field is `true` when Claude Code is already continuing as
> a result of a stop hook."

```json
{ "session_id": "abc123", "transcript_path": "...", "cwd": "...", "permission_mode": "default",
  "hook_event_name": "Stop", "stop_hook_active": true,
  "last_assistant_message": "...", "background_tasks": [], "session_crons": [] }
```

Eight consecutive Stop continuations are capped by the platform
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it). `last_assistant_message` avoids parsing the
transcript at Stop time ("the transcript file isn't guaranteed to include the final message at Stop
time on all versions").

### (c) SessionStart input: `source`

> "`source` | How the session started: `"startup"` for new sessions, `"resume"` for resumed sessions,
> `"clear"` after `/clear`, `"compact"` after compaction, or `"fork"` for a new session forked from
> an existing one"

Other fields: optional `model` (can be omitted, e.g. after `/clear`), `agent_type` (only with
`claude --agent <name>`), `session_title`. On `resume`/`fork` with at least one prior response, also
`seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`,
`estimated_cache_write_usd` (v2.1.251+). Output fields: `additionalContext`, `initialUserMessage`,
`sessionTitle`, `watchPaths`, `reloadSkills`. Handle `fork` explicitly in the hook (treat like
`resume`).

### (d) PreToolUse output shape

Decision lives under `hookSpecificOutput`, not top-level `decision`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "My reason here",
    "updatedInput": { "field_to_modify": "new value" },
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

- `permissionDecision`: `"allow"`, `"deny"`, `"ask"`, `"defer"` (`defer` works only with `-p`).
- `updatedInput` replaces the entire input object (include unchanged fields).
- Precedence when hooks disagree: `deny` > `defer` > `ask` > `allow`.
- Deny example from the docs: `permissionDecision: "deny"` with
  `permissionDecisionReason: "Database writes are not allowed"`.
- Input: `tool_name`, `tool_input`, `tool_use_id` (plus common fields).
- Deny with a reason also works via exit 2 + stderr, but the JSON form is the one to use.

### SubagentStart input and output

```json
{ "session_id": "abc123", "transcript_path": "...", "cwd": "...",
  "hook_event_name": "SubagentStart", "agent_id": "agent-abc123", "agent_type": "Explore" }
```

The field is `agent_type` (e.g. `Explore`, `general-purpose`, `Plan`, or a custom/plugin agent
name); the matcher matches on it. Output is context only and cannot block subagent creation:

```json
{ "hookSpecificOutput": { "hookEventName": "SubagentStart",
  "additionalContext": "Follow security guidelines for this task" } }
```

Exit 2 "shows stderr to user only". Not run; whether a plugin agent's `agent_type` arrives
namespaced (`nd-spike:probe`) or bare (`probe`) is unverified. The `subagent_stats.by_type` key in
the `claude -p` JSON result was namespaced (`"nd-spike:probe"`), which hints at the namespaced form,
but that is a different field. To test: add a SubagentStart hook to the spike plugin that writes
stdin to a file, and run the probe again.

### Plugin hook wiring (relevant to later tasks)

Plugin hooks go in `hooks/hooks.json`; they merge with user/project hooks. `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are substituted in the command string and also
exported as env vars to the spawned process.

## 2. Namespaced skill preload and cross-marketplace dependency

Setup: throwaway plugin at `%TEMP%\nd-spike`:

`.claude-plugin/plugin.json`
```json
{"name":"nd-spike","version":"0.0.1","dependencies":["superpowers@claude-plugins-official"]}
```

`agents/probe.md` (frontmatter `name: probe`, a `description`, `skills:` list with
`superpowers:test-driven-development`; body "Reply with the first heading of any preloaded skill, or
NONE."). The `description` line was added because agent frontmatter needs one to be delegable.

Run: `claude --plugin-dir "$TEMP/nd-spike" -p "Use the nd-spike:probe agent and report what it said"`

### Result: namespaced skill preload works

The probe agent ran (`subagent_stats.spawned: 1`, `by_type: {"nd-spike:probe": 1}`, no tools used)
and answered:

> `Test-Driven Development (TDD)`

That is the heading of `superpowers:test-driven-development`, not `NONE`, so `skills:` in a plugin
agent's frontmatter accepts a namespaced `plugin:skill` name from another plugin and preloads it.
Caveat: `superpowers@claude-plugins-official` 7.0.0 was installed and enabled at user scope on this
machine, so this proves resolution when the other plugin is present, not when it is absent.

### Result: dependency produced no error (when already installed)

- `claude plugin validate nd-spike` reported only warnings (missing description/author) and
  directory-submission problems (README, LICENSE, icon). Nothing about the dependency.
- `claude --plugin-dir ... plugin list` shows `nd-spike@inline`, `Version: 0.0.1`, `Status: loaded`.
- Interactive `/plugin` -> Errors tab could not be opened in this non-interactive session, so the
  absence of an error there is inferred from `Status: loaded` and from the run succeeding.

Docs (plugin-dependencies page): a cross-marketplace string `"name@marketplace"` is allowed. By
default a dependency from another marketplace is not installed "unless the user already has that
dependency installed and enabled at the same scope". Otherwise the root marketplace's
`marketplace.json` needs `allowCrossMarketplaceDependenciesOn: ["claude-plugins-official"]`. If the
dependency is declared in `plugin.json` and not allowed, "the install completes without the
dependency and your plugin then fails to load".

Not verified: a user without superpowers installed. Test would be a clean profile with a local
marketplace containing `nd-spike`, with and without the `allowCrossMarketplaceDependenciesOn`
entry, then `/plugin` -> Errors. I did not do this, to avoid disabling the real superpowers install.

Design consequence: if `nauraiz-dev` declares the dependency, its marketplace.json must list
`claude-plugins-official` in `allowCrossMarketplaceDependenciesOn`. Agents referencing
`superpowers:*` skills should degrade gracefully (the skill simply not preloading) rather than
assume it is there.

## 3. Transcript sample

Fixture: `tests/fixtures/transcript.sample.jsonl`, 40 lines, valid JSONL, taken from one contiguous
window of a real session (Claude Code 2.1.221, `entrypoint: claude-desktop`), then scrubbed by a
whitelist: every string value became `…` unless its key is a structural enum (`type`, `role`,
`model`, `stop_reason`, `service_tier`, `inference_geo`, `speed`, `subtype`, `level`, `userType`,
`entrypoint`, `version`, `effort`, `permissionMode`, `operation`, `timestamp`, tool `name`).
Ids/uuids were renumbered consistently (`id-001`...), so parent links and tool_use/tool_result
pairs still match. Paths became `/repo/src/a.js`, `cwd` became `/repo`, `gitBranch` became
`feature/12-example`. All numbers (including every `usage.*` count) and timestamps are unchanged.
Bash commands were rewritten: the final one is `npm run build` (11:02:18Z), the two earlier ones are
`git status --short`. The two `Edit` tool_uses are at 10:47:26Z and 10:47:52Z, so the gate run is
after the last edit. The fixture contains: 2 `Edit`, 3 `Bash`, 1 `Skill`, 3 `Read` tool_use blocks.

### Record types seen (`type`)

`assistant`, `user`, `system`, `attachment`, `queue-operation`, `last-prompt`, `custom-title`. Other
types exist in other sessions (`permission-mode`, `file-history-snapshot`, `ai-title`, `mode`,
`cost-state`, ...). The consumer must ignore unknown types. `last-prompt` and `custom-title` have no
`timestamp`. Timestamps are not strictly monotonic across lines (a `system` line at 10:48:05Z sits
after a `queue-operation` at 11:01:55Z), so sort or compare by `timestamp`, not file order, when it
matters.

### Fields per record type (as present)

- `assistant`: `parentUuid, isSidechain, message, requestId, type, uuid, timestamp, effort,
  userType, entrypoint, cwd, sessionId, version, gitBranch` (+ `attributionSkill`,
  `attributionPlugin` on some).
- `user`: `parentUuid, isSidechain, promptId, type, message, uuid, timestamp, toolUseResult,
  sourceToolAssistantUUID, userType, entrypoint, cwd, sessionId, version, gitBranch` (+
  `permissionMode, origin, promptSource` on prompts; `isMeta, sourceToolUseID` on injected text).
- `system`: `subtype` (`stop_hook_summary`), `hookCount, hookInfos, hookErrors,
  hookAdditionalContext, preventedContinuation, stopReason, hasOutput, level, timestamp, uuid,
  toolUseID`.
- `attachment`: `attachment` (object with its own `type`, e.g. `task_reminder`), `uuid, timestamp`.
- `queue-operation`: `operation` (`enqueue`/`dequeue`), `timestamp, sessionId, content`.
- `last-prompt`: `lastPrompt, leafUuid, sessionId`. `custom-title`: `customTitle, sessionId`.

### `assistant.message`

Keys: `model, id, type, role, content, stop_reason, stop_sequence, stop_details, usage,
diagnostics`. One API message is split across several transcript lines, one per content block
(`thinking`, `text`, `tool_use`), all with the same `message.id` and the same `message.usage`.
Summing `usage` over lines would multiply-count: dedupe by `message.id` first.

`message.content[]` block shapes seen: `{type:"text", text}`, `{type:"thinking", thinking, signature}`,
`{type:"tool_use", id, name, input, caller:{type:"direct"}}`.

`Edit` input: `replace_all, file_path, old_string, new_string`. `Bash` input: `command,
description`. Tool name is `message.content[].name` (`Edit`, `Bash`, `Read`, `Skill`, ...).

### `message.usage.*`

`input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
server_tool_use{web_search_requests, web_fetch_requests}, service_tier,
cache_creation{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}, inference_geo,
iterations[{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
cache_creation{...}, type}], speed`. Example from the fixture: `input_tokens 1,
cache_creation_input_tokens 1289, cache_read_input_tokens 110584, output_tokens 1041`.

### `user` tool results

A tool result is a `user` line whose `message.content` is an array of
`{tool_use_id, type:"tool_result", content}`. The line also carries a top-level `toolUseResult`
whose shape depends on the tool (for `Edit`: `filePath, oldString, newString, originalFile,
structuredPatch[{oldStart, oldLines, newStart, newLines, lines[]}], userModified, ...`). A human
prompt is a `user` line whose `message.content` is a plain string.

### Windows paths

In real transcripts `cwd` and `file_path` use Windows form (`<drive>:\\...`); the fixture uses
POSIX form. Path-matching code must normalise separators.
