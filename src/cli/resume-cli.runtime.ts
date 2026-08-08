// Resolves recent Gateway sessions and attaches the existing TUI to the selected key.
import { cancel, isCancel } from "@clack/prompts";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { defaultRuntime } from "../runtime.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import {
  buildSessionChoices,
  loadRecentSessions,
  type SessionPickerChoice,
} from "../tui/tui-session-picker.js";
import type { ResumeCliOptions } from "./resume-cli.js";

export type ResumeResolution =
  | { kind: "match"; session: SessionPickerChoice }
  | { kind: "ambiguous"; candidates: SessionPickerChoice[] }
  | { kind: "none" };

/** Resolve a recent session by exact key, unique substring, then TUI-style fuzzy matching. */
export function resolveResumeSession(
  sessions: readonly TuiSessionList["sessions"][number][],
  query: string,
): ResumeResolution {
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeLowercaseStringOrEmpty(trimmedQuery);
  const choices = buildSessionChoices(sessions);
  const exact = choices.find((choice) => choice.value === trimmedQuery);
  if (exact) {
    return { kind: "match", session: exact };
  }

  const substringMatches = choices.filter((choice) =>
    normalizeLowercaseStringOrEmpty(choice.matchText).includes(normalizedQuery),
  );
  if (substringMatches.length === 1) {
    return { kind: "match", session: substringMatches[0] };
  }
  if (substringMatches.length > 1) {
    return { kind: "ambiguous", candidates: substringMatches };
  }

  const fuzzyMatches = fuzzyFilter(choices, trimmedQuery, (choice) => choice.matchText);
  if (fuzzyMatches.length === 1) {
    return { kind: "match", session: fuzzyMatches[0] };
  }
  if (fuzzyMatches.length > 1) {
    return { kind: "ambiguous", candidates: fuzzyMatches };
  }
  return { kind: "none" };
}

async function fetchResumeSessions(opts: ResumeCliOptions) {
  const { GatewayChatClient } = await import("../tui/gateway-chat.js");
  const client = await GatewayChatClient.connect(opts);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        complete();
      };
      client.onConnected = () => finish(resolve);
      client.onConnectError = (error) => finish(() => reject(error));
      client.onDisconnected = (reason) =>
        finish(() => reject(new Error(reason || "Gateway connection closed")));
      client.start();
    });
    return await loadRecentSessions(client);
  } catch (error) {
    const [{ formatTuiErrorMessage }, { resolveGatewayDisconnectState }] = await Promise.all([
      import("../tui/tui-formatters.js"),
      import("../tui/tui.js"),
    ]);
    const state = resolveGatewayDisconnectState(formatTuiErrorMessage(error));
    throw new Error(
      [
        state.connectionStatus,
        state.pairingHint ??
          "Ensure the Gateway is running and your --url/--token/--password are correct.",
      ].join("\n"),
    );
  } finally {
    await client.stop();
  }
}

async function promptResumeSession(
  sessions: readonly TuiSessionList["sessions"][number][],
): Promise<string | null> {
  const choices = buildSessionChoices(sessions);
  if (choices.length === 0) {
    throw new Error(
      "No recent sessions found. Run `openclaw sessions` to inspect sessions or `openclaw tui` to start one.",
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Session selection requires an interactive terminal. Pass a session key or name: `openclaw resume <query>`.",
    );
  }
  const selected = await selectStyled({
    message: "Resume a session",
    options: choices.map((choice) => ({
      value: choice.value,
      label: formatResumeCandidate(choice),
      hint: choice.description ? sanitizeTerminalText(choice.description) : undefined,
    })),
  });
  if (isCancel(selected)) {
    cancel("Cancelled.");
    return null;
  }
  return selected;
}

function reportResumeFailure(
  query: string,
  resolution: Exclude<ResumeResolution, { kind: "match" }>,
) {
  if (resolution.kind === "ambiguous") {
    defaultRuntime.error(`Session query ${JSON.stringify(query)} is ambiguous. Candidates:`);
    for (const candidate of resolution.candidates) {
      defaultRuntime.error(`  ${formatResumeCandidate(candidate)}`);
    }
    defaultRuntime.error("Use a longer name or the exact session key.");
    return;
  }
  defaultRuntime.error(`No recent session matched ${JSON.stringify(query)}.`);
  defaultRuntime.error(
    "Run `openclaw resume` to choose from recent sessions or `openclaw sessions` to inspect all sessions.",
  );
}

function formatResumeCandidate(candidate: SessionPickerChoice): string {
  const label = sanitizeTerminalText(candidate.label);
  const key = sanitizeTerminalText(candidate.value);
  return label === key ? key : `${label} [${key}]`;
}

/** Resolve or select one session and run the existing Gateway-backed TUI. */
export async function runResumeCommand(query: string | undefined, opts: ResumeCliOptions) {
  const sessions = await fetchResumeSessions(opts);
  const trimmedQuery = query?.trim();
  let sessionKey: string | null;
  if (trimmedQuery) {
    const resolution = resolveResumeSession(sessions, trimmedQuery);
    if (resolution.kind !== "match") {
      reportResumeFailure(trimmedQuery, resolution);
      defaultRuntime.exit(1);
      return;
    }
    sessionKey = resolution.session.value;
  } else {
    sessionKey = await promptResumeSession(sessions);
  }
  if (!sessionKey) {
    return;
  }
  const { runTui } = await import("../tui/tui.js");
  await runTui({
    url: opts.url,
    token: opts.token,
    password: opts.password,
    tlsFingerprint: opts.tlsFingerprint,
    session: sessionKey,
    forceProcessExitOnReturn: true,
  });
}
