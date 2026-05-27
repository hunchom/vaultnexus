# VaultNexus 16 — `reason_over_vault` LLM Compose Layer

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Wave-2 of concept §4 — the natural-language `reason_over_vault` answer that rides on top of Plan 12's citation chain. Provider-agnostic: **Anthropic** (Claude), **OpenAI**, AND **OpenAI-compatible local** endpoints (Ollama / LM Studio / vLLM / etc.) — all selectable at runtime via env. The citation contract is **preserved end-to-end**: the compose layer can only cite hops in the chain Plan 12 produced. The model is asked to attach inline `[ref:notePath:byteStart-byteEnd]` markers; hops the model doesn't use are dropped silently — never invented.

**Why all three providers:** the user wants choice. Anthropic for Claude users, OpenAI for OpenAI users, openai-compatible for users running local models (full local-first stance). Same env-driven selector pattern as Plan 06's `selectEmbedder` — different keys, same shape.

**Architecture:**

- `src/core/chat-model.ts` — provider-agnostic interface:
  ```typescript
  export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
  export interface ChatModel {
    readonly id: string;
    compose(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
  }
  ```
- `src/core/fake-chat-model.ts` — `FakeChatModel` deterministic test stub: returns a fixed-template answer derived from the user-message text (e.g. extracts the question + first 200 chars of injected chain, echoes a canned shape). No network. For unit tests + offline default.
- `src/daemon/ai-chat-model.ts` — AI-SDK-backed implementations:
  - `createAnthropicChatModel({ apiKey, model = 'claude-sonnet-4-6' })` (via `@ai-sdk/anthropic`)
  - `createOpenAIChatModel({ apiKey, model = 'gpt-4o-mini' })` (via `@ai-sdk/openai`)
  - `createOpenAICompatibleChatModel({ baseURL, apiKey, model })` (via `@ai-sdk/openai-compatible` for local / 3rd-party)
- `src/daemon/select-chat-model.ts` — env-driven factory (mirrors Plan 06's `selectEmbedder`):
  - `VAULTNEXUS_CHAT_PROVIDER` ∈ `{anthropic, openai, openai-compatible, fake}` (default `fake`).
  - Provider-specific envs:
    - `anthropic`: `VAULTNEXUS_CHAT_KEY` (required), `VAULTNEXUS_CHAT_MODEL` (optional, default `claude-sonnet-4-6`).
    - `openai`: `VAULTNEXUS_CHAT_KEY` (required), `VAULTNEXUS_CHAT_MODEL` (optional, default `gpt-4o-mini`).
    - `openai-compatible`: `VAULTNEXUS_CHAT_URL` + `VAULTNEXUS_CHAT_KEY` + `VAULTNEXUS_CHAT_MODEL` (all required).
    - `fake`: no envs.
  - Missing required envs for the chosen provider → throw a clear error at startup (NOT silent fallback to Fake — that would mask config bugs).
- `src/core/compose-prompt.ts` — pure prompt builder. Takes `(question: string, hops: ReasonHop[])` → `ChatMessage[]`. The system prompt is the citation contract: "Every claim must cite `[ref:notePath:byteStart-byteEnd]` using ONLY the hops below. If a hop doesn't support a claim, do not invent a citation; drop the claim. Format: prose with inline `[ref:…]` markers." The user message contains the question + a numbered chain of hops (`#1 path: ... heading: ... text: ...`).
- `src/daemon/reason-compose.ts` — orchestrator. Calls `VaultIndex.trace(question, traceOpts)` to get hops; if zero, returns `{ answer: 'No relevant context found in vault.', hops: [] }`. Otherwise builds prompt via `compose-prompt.ts`, calls `chatModel.compose(messages)`, returns `{ answer: string, hops: ReasonHop[] }`. Hops returned are the same array trace produced — the user can verify model output against them.
- `src/daemon/vault-index.ts` — `reason(question, opts)` method takes a `ChatModel` (injected). Returns `{ answer, hops }`.
- `src/daemon/mcp-server.ts` — register `vaultnexus_reason` tool. Params: `question` (required), `maxDepth?`, `kSeeds?`, `knnPerHop?`, `simThreshold?`, `maxHops?`, `maxTokens?`, `temperature?`. Returns JSON `{ answer, hops, model: string }` (model id for transparency).
- `src/daemon/main.ts` — wire `selectChatModel()` into the index alongside the embedder.

**Tech stack:** TS/ESM/NodeNext, vitest. **New deps:** `ai` (Vercel AI SDK core), `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`. All published, MIT-licensed, well-maintained.

**Non-goals (later plans):**
- Streaming responses (single-shot for v1; streaming wraps the same `ChatModel` later).
- True async reasoning lane (concept §4 mentions "the LLM compose step is the cost, so this lives on the async reasoning lane" — Plan 16 ships compose-on-demand synchronously; an async-queue layer is a separate concern).
- Multi-turn conversation (single Q&A; the answer is the contract).
- Tool-use / function-calling (would let the model fetch more context dynamically; deferred).
- Cost tracking / budget enforcement (the daemon doesn't meter spend; users gate at the MCP-client layer).
- Local model loading via `node-llama-cpp` in-process (out of scope; openai-compatible adapter covers Ollama / LM Studio / vLLM which is the well-paved local path).

---

## File Structure

- Create `src/core/chat-model.ts` — `ChatModel` interface + `ChatMessage` type.
- Create `src/core/fake-chat-model.ts` — `FakeChatModel`.
- Create `src/core/compose-prompt.ts` — `buildComposePrompt(question, hops): ChatMessage[]`.
- Create `src/daemon/ai-chat-model.ts` — three AI-SDK adapters.
- Create `src/daemon/select-chat-model.ts` — env-driven factory.
- Create `src/daemon/reason-compose.ts` — orchestrator (`composeAnswer(facade, question, opts)`).
- Modify `src/daemon/vault-index.ts` — `reason(question, opts)` method; ctor accepts `chatModel?`.
- Modify `src/daemon/main.ts` — call `selectChatModel()`, pass to `VaultIndex`.
- Modify `src/daemon/mcp-server.ts` — register `vaultnexus_reason` tool.
- Tests:
  - `test/core/fake-chat-model.test.ts` — determinism + shape.
  - `test/core/compose-prompt.test.ts` — prompt-building contract (system + user shape, hops formatted correctly, byte-offset cites included).
  - `test/daemon/reason-compose.test.ts` — full flow against FakeChatModel + Plan 14 fixture.
  - `test/daemon/mcp-reason.test.ts` — MCP roundtrip + presence/absence.
  - `test/daemon/ai-chat-model.test.ts` — GATED real-model tests (skipIf no key). One test per provider that an env can satisfy; default: skip all.

---

## Task 1 — `ChatModel` interface + `FakeChatModel`

**Files:** Create `src/core/chat-model.ts`; Create `src/core/fake-chat-model.ts`; Create `test/core/fake-chat-model.test.ts`

- [ ] **Step 1:** Define the interface in `src/core/chat-model.ts`:
  ```typescript
  export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
  export interface ChatComposeOpts { maxTokens?: number; temperature?: number; }
  export interface ChatModel {
    readonly id: string;
    compose(messages: ChatMessage[], opts?: ChatComposeOpts): Promise<string>;
  }
  ```
- [ ] **Step 2: Failing test** — `FakeChatModel.id === 'fake'`. `compose([{role:'user', content:'hello'}])` returns a string that contains `'hello'` (echo) AND is deterministic across calls. Two instances → same output for same input.
- [ ] **Step 3: Implement** `FakeChatModel`:
  ```typescript
  export class FakeChatModel implements ChatModel {
    readonly id = 'fake';
    async compose(messages: ChatMessage[]): Promise<string> {
      const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      // deterministic stub → echoes question + first 200 chars of the user payload
      return `[fake-compose] ${user.slice(0, 200)}`;
    }
  }
  ```
- [ ] **Step 4:** `pnpm test -- fake-chat-model`. Green.

---

## Task 2 — `buildComposePrompt` (pure prompt builder)

**Files:** Create `src/core/compose-prompt.ts`; Create `test/core/compose-prompt.test.ts`

- [ ] **Step 1: Failing test** — given `question: 'What did I conclude about GTD?'` + a 2-hop `ReasonHop[]` (one seed, one wikilink), `buildComposePrompt` returns a `ChatMessage[]` where:
  - Length 2 (system + user).
  - System message contains the substring `[ref:` (citation marker convention).
  - System message contains the substring `do not invent` (no-fabrication rule).
  - User message contains the question text VERBATIM.
  - User message contains BOTH hop's `notePath` strings.
  - User message contains BOTH hop's `byteStart-byteEnd` ranges as a `[ref:notePath:start-end]` marker.
- [ ] **Step 2: Implement.** System prompt template:
  ```
  You answer questions about a knowledge vault. Every claim in your answer
  MUST be backed by one of the citations below, using the exact form
  `[ref:notePath:byteStart-byteEnd]`. If a citation does not support a claim,
  do not invent the link — drop the claim. Use the citations inline (mid-prose).
  Be concise; under 200 words.
  ```
  User prompt template:
  ```
  Question: <question>

  Available citations:
  #1 [ref:<path>:<start>-<end>] heading: <headingPath joined by ' > '>
     text: <chunk.text>

  #2 [ref:<path>:<start>-<end>] heading: ...
     text: ...

  ...
  ```
  Pure function — no I/O. Just string assembly.
- [ ] **Step 3:** Green.

---

## Task 3 — AI-SDK adapters

**Files:** Create `src/daemon/ai-chat-model.ts`; Create `test/daemon/ai-chat-model.test.ts`

- [ ] **Step 1:** Install deps:
  ```bash
  pnpm add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/openai-compatible
  ```
  Use the latest stable. AI SDK v4+ has `generateText({ model, messages })` returning `{ text }`.
- [ ] **Step 2: Implement** in `src/daemon/ai-chat-model.ts`:
  ```typescript
  import { generateText } from 'ai';
  import { createAnthropic } from '@ai-sdk/anthropic';
  import { createOpenAI } from '@ai-sdk/openai';
  import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
  import type { ChatModel, ChatMessage, ChatComposeOpts } from '../core/chat-model.js';

  export function createAnthropicChatModel(p: { apiKey: string; model?: string }): ChatModel {
    const provider = createAnthropic({ apiKey: p.apiKey });
    const modelId = p.model ?? 'claude-sonnet-4-6';
    return { id: `anthropic:${modelId}`, compose: (msgs, opts) => call(provider(modelId), msgs, opts) };
  }
  export function createOpenAIChatModel(p: { apiKey: string; model?: string }): ChatModel { ... }
  export function createOpenAICompatibleChatModel(p: { baseURL: string; apiKey: string; model: string; name?: string }): ChatModel { ... }

  async function call(model: any, messages: ChatMessage[], opts: ChatComposeOpts = {}): Promise<string> {
    const { text } = await generateText({ model, messages, maxTokens: opts.maxTokens ?? 800, temperature: opts.temperature ?? 0.2 });
    return text;
  }
  ```
- [ ] **Step 3: GATED test** — for each provider, a test that runs ONLY when its env is set:
  ```typescript
  describe.skipIf(!process.env.VAULTNEXUS_TEST_ANTHROPIC_KEY)('AnthropicChatModel (gated)', () => { ... });
  ```
  The test calls `compose([{role:'user', content:'reply with the literal word: PONG'}])` and asserts the response contains `PONG`. **Three tests, three gates, default-skip.** Do NOT use the existing `VAULTNEXUS_EMBED_KEY` — that's for embeddings, may not match the chat provider.
- [ ] **Step 4:** `pnpm test`. Green; the three gated tests skip.

---

## Task 4 — `selectChatModel()` env factory

**Files:** Create `src/daemon/select-chat-model.ts`; Extend `test/daemon/ai-chat-model.test.ts` (or new file).

- [ ] **Step 1: Failing test** — with no envs, `selectChatModel(env={})` returns `FakeChatModel`. With `VAULTNEXUS_CHAT_PROVIDER=anthropic, VAULTNEXUS_CHAT_KEY=k`, returns an Anthropic ChatModel (assert `id.startsWith('anthropic:')`). With `VAULTNEXUS_CHAT_PROVIDER=anthropic` but NO key, throws an error containing the substring `VAULTNEXUS_CHAT_KEY`. Repeat the missing-key throw for the other two providers (`openai`, `openai-compatible`). For `openai-compatible`, also assert it throws when `VAULTNEXUS_CHAT_URL` is missing.
- [ ] **Step 2: Implement:**
  ```typescript
  export function selectChatModel(env: NodeJS.ProcessEnv = process.env): ChatModel {
    const provider = env.VAULTNEXUS_CHAT_PROVIDER ?? 'fake';
    if (provider === 'fake') return new FakeChatModel();
    if (provider === 'anthropic') {
      const key = need(env, 'VAULTNEXUS_CHAT_KEY');
      return createAnthropicChatModel({ apiKey: key, model: env.VAULTNEXUS_CHAT_MODEL });
    }
    if (provider === 'openai') { ... }
    if (provider === 'openai-compatible') { ... }
    throw new Error(`unknown VAULTNEXUS_CHAT_PROVIDER: ${provider}`);
  }
  function need(env: NodeJS.ProcessEnv, name: string): string {
    const v = env[name];
    if (!v) throw new Error(`${name} required for VAULTNEXUS_CHAT_PROVIDER=${env.VAULTNEXUS_CHAT_PROVIDER}`);
    return v;
  }
  ```
- [ ] **Step 3:** Green.

---

## Task 5 — `composeAnswer` orchestrator + `VaultIndex.reason`

**Files:** Create `src/daemon/reason-compose.ts`; Modify `src/daemon/vault-index.ts`; Create `test/daemon/reason-compose.test.ts`

- [ ] **Step 1: Failing test** — build a `VaultIndex` with the Plan 14 seeded vault notes (`addNote` for each) using `FakeEmbedder` and inject a `FakeChatModel`. Call `index.reason('What about GTD?', { maxDepth: 1 })`. Assert:
  - Returns `{ answer: string, hops: ReasonHop[] }`.
  - `hops.length > 0` (Plan 12's trace produces seeds at minimum).
  - `answer` contains the FakeChatModel marker `[fake-compose]` (proves compose-layer ran).
  - `answer` contains at least one of the seed hops' `notePath` strings (FakeChatModel echoes the prompt which includes the chain).

- [ ] **Step 2: Implement** `composeAnswer`:
  ```typescript
  export async function composeAnswer(
    facade: TraceFacade,          // same facade as Plan 12
    chat: ChatModel,
    question: string,
    opts: TraceOptions & ChatComposeOpts = {},
  ): Promise<{ answer: string; hops: ReasonHop[] }> {
    const hops = await traceReasoning(facade, question, opts);
    if (hops.length === 0) return { answer: 'No relevant context found in vault.', hops: [] };
    const messages = buildComposePrompt(question, hops);
    const answer = await chat.compose(messages, { maxTokens: opts.maxTokens, temperature: opts.temperature });
    return { answer, hops };
  }
  ```
- [ ] **Step 3:** Add to `VaultIndex` (ctor extended again):
  ```typescript
  constructor(
    private readonly embedder: Embedder,
    private readonly vaultPath?: string,
    private readonly chatModel?: ChatModel,
  ) {}
  async reason(question: string, opts: TraceOptions & ChatComposeOpts = {}): Promise<{ answer: string; hops: ReasonHop[] }> {
    if (!this.chatModel) throw new Error('reason() requires a ChatModel — pass via VaultIndex(embedder, vaultPath, chatModel)');
    // build facade same as trace() — extract a private helper to avoid duplication
    return composeAnswer(this.makeFacade(), this.chatModel, question, opts);
  }
  ```
  (You may refactor the inline-facade-build from `trace()` into a private `makeFacade()` helper so both methods share it. Confirm the existing `trace()` tests still pass.)
- [ ] **Step 4:** Green.

---

## Task 6 — `vaultnexus_reason` MCP tool

**Files:** Modify `src/daemon/mcp-server.ts`; Create `test/daemon/mcp-reason.test.ts`

- [ ] **Step 1: Failing test** — spin up the in-memory MCP server with an indexed `VaultIndex` + `FakeChatModel`. Call `vaultnexus_reason` with `{ question: 'How does GTD work?' }`. Parse response JSON. Assert keys `answer`, `hops`, `model` exist; `model === 'fake'`; `hops` is an array.
- [ ] **Step 2: Implement.** Add to `createMcpServer`:
  ```typescript
  server.registerTool('vaultnexus_reason', {
    description: 'Cited answer to a question over the vault. Composes via LLM on top of the citation chain (Plan 12 trace). Model id returned for transparency. Every claim cites [ref:notePath:byteStart-byteEnd] from the chain; hops the model could not substantiate are dropped, never invented.',
    inputSchema: {
      question: z.string(),
      maxDepth: z.number().int().nonnegative().optional(),
      kSeeds: z.number().int().positive().optional(),
      knnPerHop: z.number().int().positive().optional(),
      simThreshold: z.number().optional(),
      maxHops: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().optional(),
    },
  }, async (params) => {
    const result = await index.reason(params.question, params);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, model: index.chatModelId() }) }] };
  });
  ```
  Add a `chatModelId(): string` getter on `VaultIndex` that returns `this.chatModel?.id ?? 'none'`.
- [ ] **Step 3:** Green.

---

## Task 7 — `main.ts` wiring

**Files:** Modify `src/daemon/main.ts`

- [ ] **Step 1: Failing test (existing tests must keep passing).** The existing main-startup tests must not break — `VaultIndex` ctor change is additive; chat model defaults to FakeChatModel when no env is set.
- [ ] **Step 2: Implement** — call `selectChatModel(process.env)` and pass to `new VaultIndex(embedder, vaultPath, chatModel)`. Log the chat-model id at startup (one line: `vaultnexus: chat model = anthropic:claude-sonnet-4-6` etc.).
- [ ] **Step 3:** Full suite green.

---

## Task 8 — Verification + final commit

- [ ] **Step 1:** `pnpm typecheck` — 0 errors.
- [ ] **Step 2:** `pnpm test` — all green (~195 tests; baseline 180 + ~15 new). The three gated real-model tests skip by default.
- [ ] **Step 3:** `pnpm build` — clean.
- [ ] **Step 4:** Manual sanity for each provider — DO NOT run with real keys autonomously (they cost money + the user manages keys). Just verify the env→adapter→error-on-missing-key path is clean by setting `VAULTNEXUS_CHAT_PROVIDER=anthropic` without a key and confirming the daemon errors at startup with a clear message.
- [ ] **Step 5:** Verify author + `.claude/` exclusion + no MCP tool removed (only added).

---

## Verification before completion

- [ ] `pnpm test` — green, ~195 tests.
- [ ] `pnpm typecheck` — 0 errors.
- [ ] `pnpm build` — clean.
- [ ] **New deps added:** `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`. Each is justified in the spec.
- [ ] Caveman-ULTRA on code comments. Spec docs are normal prose. Prompt templates inside source are normal prose (the LLM reads them).
- [ ] All commits authored as `Roger French <merihmengisteab@gmail.com>`.
- [ ] No `Claude` / `Anthropic` / `Co-Authored-By` / `noreply@anthropic` strings in commit messages or non-code files. **Exception:** the `@ai-sdk/anthropic` package name appears in `package.json` — that is a legitimate dep name and is REQUIRED here. The attribution rule is about authorship, not about referencing the company in dep manifests. (Same as how `node` ships with code that says "Node.js" — package names are mechanical, not attribution.)
- [ ] **Do NOT rewrite history.** **Do NOT `git add -A`.**

---

## Decision log

- **Why AI SDK over rolling our own three undici clients:** the user pre-decided this in the concept doc ("AI-SDK chat/judge only + own undici embed/rerank"). AI SDK abstracts the three providers cleanly with a small, well-maintained surface. Embeddings stay on `undici` because the AI SDK's embedding support is thinner and we already have a working `OpenAIEmbedder`.
- **Why `claude-sonnet-4-6` as the Anthropic default:** per system-prompt model knowledge, that's the most-recent stable Sonnet (`claude-opus-4-7` is the most-recent Opus; Opus is overkill for cite-aware compose at this scale; Sonnet 4.6 is the cost/quality sweet spot).
- **Why `gpt-4o-mini` as the OpenAI default:** cheapest model that handles citation-aware compose competently. Users can override via `VAULTNEXUS_CHAT_MODEL`.
- **Why hard-error on missing keys (NOT silent FakeChatModel fallback):** if a user sets `VAULTNEXUS_CHAT_PROVIDER=anthropic` and forgets the key, they want to fix that, not silently get garbage. Plan 11's `selectEmbedder` falls back to FakeEmbedder when ALL three embed envs are absent — the analog here is that absent `VAULTNEXUS_CHAT_PROVIDER` (defaults to `fake`) is the silent path; setting an explicit provider commits to it.
- **Why model id in the response:** transparency. Users reviewing `vaultnexus_reason` output should know which model produced it. Useful for debugging compose-quality regressions across model swaps.
- **Why no streaming in v1:** an MCP tool's return value is single-shot anyway (the tool-call boundary is the response). Streaming is a transport concern that wraps the same `ChatModel.compose` later if MCP gains streaming response support.
- **Why no tool-use / function-calling:** that lets the model fetch *more* context dynamically (e.g. call `vaultnexus_search` mid-reasoning). Adds a lot of complexity + cost. The Plan 12 chain is *already* the relevant context; the compose step just narrates it. If a downstream user wants tool-use, they can call `vaultnexus_trace` + `vaultnexus_reason` themselves from their own agent loop.
- **Why preserve the `vaultnexus_trace` tool (NOT replace with `_reason`):** trace is **deterministic + free**. Reason is **stochastic + paid**. Both have legit use cases: a CLI script wanting deterministic citation chains uses trace; a chat caller wanting prose uses reason. Different surfaces for different workflows.
- **Why error-throw on `reason()` without a ChatModel injected (rather than fallback to Fake):** same logic as the env hard-error. Calling `reason()` is opt-in; if the caller passes no model, they have a config bug. FakeChatModel is for tests and explicit offline use, not silent prod-path fallback.
