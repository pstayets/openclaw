// Shared recent-session query and presentation used by the TUI and CLI resume picker.
import { formatRelativeTimestamp } from "../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiBackend, TuiSessionList } from "./tui-backend.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";

type TuiSessionEntry = TuiSessionList["sessions"][number];

/** One recent session rendered consistently across interactive pickers. */
export type SessionPickerChoice = {
  value: string;
  label: string;
  description: string;
  searchText: string;
  matchText: string;
};

/** Load the same bounded recent-session window used by the TUI Ctrl+P picker. */
export async function loadRecentSessions(
  client: Pick<TuiBackend, "listSessions">,
  options: { agentId?: string } = {},
): Promise<TuiSessionEntry[]> {
  const result = await client.listSessions({
    limit: TUI_SESSION_PICKER_LIMIT,
    activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
    includeGlobal: false,
    includeUnknown: false,
    includeDerivedTitles: true,
    includeLastMessage: true,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  });
  return result.sessions;
}

/** Build labels and matching text for recent-session pickers. */
export function buildSessionChoices(sessions: readonly TuiSessionEntry[]): SessionPickerChoice[] {
  return sessions.map((session) => {
    const title = session.derivedTitle ?? session.displayName;
    const formattedKey = formatSessionKey(session.key);
    const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
    const timePart = session.updatedAt
      ? formatRelativeTimestamp(session.updatedAt, { dateFallback: true, fallback: "" })
      : "";
    const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
    const description = timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
    const searchableNames = [
      session.derivedTitle,
      session.displayName,
      session.label,
      session.subject,
      session.sessionId,
      session.key,
    ].filter((value): value is string => Boolean(value));
    return {
      value: session.key,
      label,
      description,
      searchText: [...searchableNames, session.lastMessagePreview].filter(Boolean).join(" "),
      matchText: searchableNames.join(" "),
    };
  });
}

function formatSessionKey(key: string): string {
  return parseAgentSessionKey(key)?.rest ?? key;
}
