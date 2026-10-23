import {
  API,
  sessionResponseSchema,
  promptResponseSchema,
  type Model,
  interruptResponseSchema,
} from "./api";
import { Store, type Notice } from "./store";
const sid = (id: string) => `/api/session/${encodeURIComponent(id)}`;
export class Bridge {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly api: API,
    readonly store: Store,
  ) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async start(
    directory: string,
    title?: string,
    model?: Model,
    agent?: string,
  ) {
    await this.api.health();
    const { data } = await this.api.request(
      "/api/session",
      sessionResponseSchema,
      {
        location: { directory },
        title,
        model,
        agent,
      },
    );
    return this.store.claim(data.id, data.location.directory);
  }
  async attach(id: string) {
    const { data } = await this.api.request(sid(id), sessionResponseSchema);
    return this.store.claim(id, data.location.directory);
  }
  async prompt(id: string, text: string) {
    const s = this.store.get(id);
    if (s.run)
      throw new Error(
        "A task is already active or its submission is uncertain. Inspect/stop it before sending another prompt.",
      );
    const run = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    this.store.update(id, run, "submitting"); // Commit intent before the HTTP side effect.
    try {
      await this.api.request(`${sid(id)}/prompt`, promptResponseSchema, {
        id: run,
        text,
      });
      this.store.update(id, run, "running");
    } catch (error) {
      this.store.update(id, run, "submission_uncertain", {
        id: `${run}:submission`,
        content: `Prompt acceptance is uncertain. Do not automatically resend. Inspect the session. ${String(error)}`,
      });
      throw new Error(`Session ${id}, run ${run}: ${String(error)}`);
    }
    return { session_id: id, run_id: run, state: "running" };
  }
  async stop(id: string) {
    const s = this.store.get(id);
    const result = await this.api.request(
      `${sid(id)}/interrupt?resume=false`,
      interruptResponseSchema,
      undefined,
      "POST",
    );
    this.store.update(id, s.run, "stop_requested");
    await this.reconcileSession(id);
    return result;
  }
  async inspect(id?: string) {
    if (!id)
      return {
        owner: this.store.owner,
        sessions: this.store.sessions(),
        pending: this.store.pending(),
      };
    const s = this.store.get(id);
    const [session, messages, inputs] = await Promise.all([
      this.api.request(sid(id), sessionResponseSchema),
      this.api.messages(id, s.run ?? undefined),
      this.api.inputs(id),
    ]);
    return {
      bridge: s,
      session: session.data,
      messages,
      ...inputs,
      pending: this.store.pending().filter((n) => n.session === id),
    };
  }
  async status() {
    const pending = this.store.pending();
    const workers = await Promise.all(
      this.store.sessions().map(async (worker) => {
        try {
          const [session, messages] = await Promise.all([
            this.api.request(sid(worker.id), sessionResponseSchema),
            this.api.messages(worker.id, worker.run ?? undefined),
          ]);
          const assistant = messages
            .filter((m) => m.type === "assistant")
            .at(-1);
          const last = messages.at(-1);
          return {
            session_id: worker.id,
            run_id: worker.run,
            state: worker.state,
            title: session.data.title ?? worker.id,
            model: assistant?.model ?? null,
            configured_model: session.data.model ?? null,
            agent: assistant?.agent ?? session.data.agent ?? null,
            last_activity: last
              ? {
                  type: last.type,
                  time: last.time?.completed ?? last.time?.created ?? null,
                }
              : null,
            needs_attention: pending.some(
              (n) =>
                n.session === worker.id &&
                [
                  "input_required",
                  "submission_uncertain",
                  "bridge_error",
                ].includes(n.kind),
            ),
          };
        } catch {
          return {
            session_id: worker.id,
            run_id: worker.run,
            state: worker.state,
            status_error:
              "Live details unavailable; showing last durable bridge state.",
          };
        }
      }),
    );
    return { owner: this.store.owner, sampled_at: Date.now(), workers };
  }
  async reconcileSession(id: string) {
    const s = this.store.get(id);
    // Pending human inputs are durable server records; recover them even if SSE was missed.
    const inputs = await this.api.inputs(id);
    for (const [kind, items, explanation] of [
      [
        "permission",
        inputs.permissions,
        "Human approval required in OpenCode. This bridge never approves permissions.",
      ],
      ["form", inputs.forms, "OpenCode needs an answer; respond using its UI."],
    ] as const) {
      for (const item of items)
        this.store.notice(
          `${kind}:${item.id}`,
          id,
          "input_required",
          `${explanation}\n${JSON.stringify(item)}`,
        );
    }
    if (!s.run) return;
    const messages = await this.api.messages(id, s.run);
    const index = messages.findIndex(
      (m) => m.id === s.run && m.type === "user",
    );
    if (index < 0) return; // No correlated user message: never infer success from session idle.
    const after = messages.slice(index + 1);
    const idleIndex = after.findIndex((m) => m.type === "idle");
    const boundary = idleIndex < 0 ? after : after.slice(0, idleIndex + 1);
    if (boundary.some((m) => m.type === "user")) {
      this.store.update(id, null, "interference", {
        id: `${s.run}:interference`,
        content:
          "Another client sent input during this task. Inspect OpenCode before interpreting its result.",
      });
      return;
    }
    if (idleIndex < 0) return;
    const idle = after[idleIndex];
    if (!idle.outcome) return;
    const last = boundary.filter((m) => m.type === "assistant").at(-1);
    const text =
      last?.content
        ?.filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n") ?? "";
    const error = idle.error ?? last?.error;
    const kind = error ? "failed" : idle.outcome;
    this.store.update(id, null, kind, {
      id: `${s.run}:terminal`,
      content: `${kind}\n${text || "(No final assistant text; use inspect for details.)"}${error ? `\nError: ${JSON.stringify(error)}` : ""}`,
    });
  }
  async reconcile() {
    for (const s of this.store.sessions()) {
      try {
        await this.reconcileSession(s.id);
      } catch (error) {
        const detail = String(error);
        console.error(`Reconciliation for ${s.id}: ${detail}`);
        this.store.notice(
          `monitor:${s.run ?? "attached"}:${Bun.hash(detail)}`,
          s.id,
          "bridge_error",
          `Cannot inspect OpenCode state. Task outcome is unknown. Check the server and use opencode_inspect. ${detail}`,
        );
      }
    }
  }
  async flush(send: (n: Notice) => Promise<void>, retryMs = 60000) {
    for (const n of this.store.pending()) {
      if (n.sent && Date.now() - n.sent < retryMs) continue;
      await send(n);
      this.store.sent(n.id); // Transport write is not an acknowledgement.
    }
  }
}
