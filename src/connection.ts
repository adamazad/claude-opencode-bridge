import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { API } from "./api";

// OpenCode's documented Service.Info registration, also consumed by
// @opencode/client/service. Validate the destination before sending credentials.
const registrationSchema = z.object({
  url: z.string(),
  pid: z.number().int().positive(),
  version: z.string().optional(),
  password: z.string().optional(),
});
const identitySchema = z.object({ version: z.string(), pid: z.number().int() });
const unavailable =
  "No healthy registered OpenCode v2 service. Run `opencode service status`; if none is running, run `opencode service start`, then retry. The bridge does not start or replace servers.";

export async function connectAPI(
  env: Record<string, string | undefined> = process.env,
): Promise<API> {
  // An explicit endpoint never receives a password from another service.
  if (env.OPENCODE_URL) {
    const api = new API(
      env.OPENCODE_URL,
      env.OPENCODE_SERVER_PASSWORD,
      env.OPENCODE_SERVER_USERNAME,
    );
    await api.health();
    return api;
  }
  const file = join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  );
  let registration: z.infer<typeof registrationSchema>;
  try {
    registration = registrationSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
  } catch {
    throw new Error(unavailable);
  }
  const api = new API(
    registration.url,
    env.OPENCODE_SERVER_PASSWORD ?? registration.password,
    env.OPENCODE_SERVER_USERNAME ?? "opencode",
  );
  let info: z.infer<typeof identitySchema>;
  try {
    info = await api.request("/api/info", identitySchema);
  } catch {
    // Do not expose registration contents, credentials, or server error bodies.
    throw new Error(
      "Cannot authenticate or reach the registered OpenCode service. Check `opencode service status` and remove stale OPENCODE_SERVER_PASSWORD/USERNAME overrides, then retry. No server was started or changed.",
    );
  }
  if (
    info.pid !== registration.pid ||
    (registration.version && info.version !== registration.version)
  )
    throw new Error(
      "OpenCode service registration is stale; the endpoint identity changed. Check `opencode service status` and retry. No server was started or changed.",
    );
  if (!/^\d+\./.test(info.version) || Number(info.version.split(".")[0]) < 2)
    throw new Error(`Requires OpenCode v2 or later, received ${info.version}`);
  return api;
}
