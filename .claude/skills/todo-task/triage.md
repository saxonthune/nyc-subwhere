# todo-task: triage mode

Refine a pending task from a rough idea into an executable spec that a headless agent can implement without asking questions. **This is interactive** — present findings, ask questions, get alignment before writing the spec.

**Input**: `$ARGUMENTS[1]` is the task slug. If empty, list pending tasks and ask.

## Step 1: List or select

If no slug provided, list untriaged drafts (the inbox):
```bash
bash .claude/skills/todo-task/list-drafts.sh
```

Present tasks to the user with `AskUserQuestion`:

```typescript
AskUserQuestion({
  questions: [{
    question: "Which task should we triage?",
    header: "Task",
    options: [
      // one per task, label = title, description = first line of motivation
    ],
    multiSelect: false
  }]
})
```

## Step 2: Read the task

Read the draft at `.todo-tasks/inbox/{slug}.md` (or `.todo-tasks/tasks/{slug}.md` if you're re-triaging an already-promoted spec). Understand the motivation and scope. If the slug appears in any `.todo-tasks/epics/{epic}.md` `members:` list, also read that epic file for context.

## Step 3: Research the codebase

Investigate the codebase to understand what changes are needed:

1. **Check `.carta/MANIFEST.md`** — use the tag index to map task keywords to relevant docs.
2. **Find relevant files** — Use Grep/Glob to locate code related to the task. Start broad (keyword search), then narrow to specific files.
3. **Read key files** — Read the files you'll need to modify. Understand their structure, patterns, and conventions.
4. **Understand test patterns** — Find existing tests near the code you'll change. Note the test framework, assertion style, and what's already covered.
5. **Check for gotchas** — Look for related code that might break, shared state, or implicit dependencies.
6. **Read the interfaces the change touches — closely enough to quote them.** Read the actual references a decision rests on: the repo glossary or controlled vocabulary (follow the pointer in `CLAUDE.md`/`AGENTS.md`), the current CLI or API surface the task changes (`--help`, the actual signature/enum/route), and any dataflow it moves. Read each until you can quote it exactly — the signature, the enum variants that exist today, the string a command prints, the `file:line`. A skim yields a vague briefing; a quoted interface yields a recommendation.

**Chain/epic phases:** If predecessors have not merged, do not read live code for their output — triage against the predecessor spec's `## Surface after this phase` block. The Surface stands in for code that does not exist yet; a symbol absent from it does not exist.

## Step 4: Briefing

Present your findings before writing anything — this is where you and the user align. Write for a reader who does not remember the code you just read. The briefing has four parts.

### 1. Plan Summary
One paragraph restating the task's motivation and scope in your own words. Flag anything ambiguous.

### 2. Status quo
Describe what exists today, ordered by the flow of the thing you're changing — for a code path, follow control flow in execution order, not a list of symbols. Give it in two passes:

- **Plain** — the mechanism as ideas, in the repo's own terms, with no symbol names or `file:line`. A reader who knows the system but not this code should be able to approve the approach from this pass alone.
- **Grounded** — the same path in code: each step a `file:line` with the exact signature, enum, or string.

Lead with the plain pass; don't open on a symbol the reader hasn't met yet.

### 3. Recommended changes
For each design decision the task surfaces, state your recommendation as one declarative sentence that cites the status-quo fact it rests on — e.g. "Add a `catalog add` subcommand reusing the `push_emission` write path (`usecases.rs:194`), since that path already mints a work node and its aliases." End on the recommendation, not a menu of options.

When a choice depends on the user's priority, name the deciding axis, say which option wins under the priority they've given, and ask only if that priority is genuinely unstated.

Use `AskUserQuestion` only to capture a pick the briefing has already stated — never as the place a recommendation first appears.

### 4. What it changes
The interface and dataflow delta: which signatures, routes, or data paths move, before → after. This is what the reader approves.

## Step 5: Scope check — is this one headless session?

Evaluate whether the plan can be executed by a single headless agent session. A good session targets:

- **~5-8 file modifications** (edits, not reads)
- **One cohesive feature or fix**
- **Completable in a single focused pass**
- **All design decisions already resolved**

If the task is too large (10+ files, multiple independent features, needs mid-implementation judgment), propose splitting into 2-3 smaller tasks. Write each as a separate file in `.todo-tasks/` and tell the user.

## Step 6: Rewrite as executable spec

After the user has answered all questions and confirmed the approach, **promote the draft**: write the executable spec to `.todo-tasks/tasks/{slug}.md` and delete the `.todo-tasks/inbox/{slug}.md` draft. Do NOT commit — the spec stays uncommitted (it doesn't block launching, and the orchestrator commits it automatically when you execute). Use this structure:

````markdown
# {Title}

## Motivation

{Original motivation, refined with what you learned from research.}

## Do NOT

- {Explicit negative constraints — things the agent must avoid}
- {Scope boundaries — what NOT to touch}
- {Wrong-but-easy approaches the agent might be tempted by}

## Plan

### 1. {First logical step}

{Concrete instructions. Name specific files, functions, line ranges. Describe what to change and why.}

### 2. {Second logical step}

{Continue with specifics...}

## Files to Modify

- `path/to/file.ts` — {what changes}
- `path/to/test.ts` — {what test to add/modify}

## Verification

```bash
{commands to verify the implementation}
```

## Out of Scope

- {Anything deferred to a future task}

## Notes

- {Caveats, risks, things a reviewer should watch for}

## Surface after this phase

> Required for chain/epic phases. Omit for standalone one-off tasks.

- {Symbols this phase promises to leave behind — exported functions, types,
  files — stated precisely enough that a later phase can triage against them.}
- {Behaviors / integration points the phase guarantees.}
- {Negative space: what is deliberately unchanged and can still be relied on —
  e.g. "Legacy X still exists and still works until Phase N".}
````

The `## Surface after this phase` block is the contract that downstream phases triage against. Write it precisely: if a symbol is not listed, later phases will treat it as nonexistent.

> The `## Verification` section MUST contain at least one fenced bash/sh code block. execute-plan.sh parses commands from that block to run as the verification gate.

> **Verification must be non-destructive.** The block runs inside the agent's
> worktree and whatever it commits merges to trunk. Never invoke `archive.sh`
> (sweep), `git rm`, worktree removal, or anything that mutates trunk or other
> tasks. Treat `.todo-tasks/` as orchestrator-owned and off-limits to a task's own
> verification. Test exit codes with a scoped, side-effect-free invocation.

## Step 7: Confirm and hand off

Tell the user the task has been triaged with a brief summary of the plan, then offer to launch:

```typescript
AskUserQuestion({
  questions: [{
    question: "Plan is triaged and ready. Launch background execution?",
    header: "Execute",
    options: [
      { label: "Launch now (Recommended)", description: "Run execute-plan in background, merge on success" },
      { label: "Launch (no merge)", description: "Run execute-plan, leave branch for manual review" },
      { label: "Not yet", description: "I want to review the plan file first" }
    ],
    multiSelect: false
  }]
})
```

If the user says launch, switch to execute mode for that slug.

## Triaging Guidelines

- **This is interactive.** Do not skip the briefing and rush to writing the spec. The conversation in Step 4 is where you and the user align on approach.
- **Name every file.** The agent shouldn't have to search for where to make changes.
- **Be specific about what, not how.** "Add a `getUserById` function to `users.ts` that queries by primary key" — not pseudocode.
- **Write negative constraints early.** "Do NOT" goes near the top of the spec — headless agents may not read the full document with equal attention. Ask yourself: "What's the easiest wrong implementation?" and block that path.
- **Include verification.** The agent needs to know when it's done.
- **Keep it atomic.** If triaging reveals the task is too large, split it into multiple tasks and tell the user.
- **Chain/epic phases triage against the Surface, not the code.** For a phase whose predecessors haven't merged, the predecessor's `## Surface after this phase` block is authoritative: anything absent from it does not exist, and its negative-space lines ("Legacy X still works until Phase N") are promises you can rely on.
