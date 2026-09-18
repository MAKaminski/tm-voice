import { apiGet } from "@/lib/api";
import { type CallRow, CallsScreen, type TaskRow } from "./CallsScreen";

export const dynamic = "force-dynamic";

interface Health { dial_mode: string }

export default async function Calls() {
  const [calls, tasks, health] = await Promise.all([
    apiGet<{ calls: CallRow[] }>("/calls?limit=100", { internal: true }),
    apiGet<{ tasks: TaskRow[] }>("/call-tasks?limit=100", { internal: true }),
    apiGet<Health>("/health"),
  ]);

  // apiGet swallows failures and returns null, which here would render as "no calls" — the same
  // thing it shows when the system genuinely has not dialled anyone. Telling someone their test
  // call did not happen when in fact we cannot see is the one wrong answer on this page.
  if (!calls || !tasks) {
    return (
      <>
        <h1>Calls</h1>
        <div className="empty bad">
          Could not reach the api. This is not an empty call log — do not assume no calls were placed.
        </div>
      </>
    );
  }

  // Only the tasks that never became a call are worth surfacing separately; 'dialed' and 'done'
  // already appear in the log below with far more detail.
  const blocked = tasks.tasks.filter((t) => t.status === "queued" || t.status === "blocked" || t.status === "claimed");

  return (
    <CallsScreen
      calls={calls.calls}
      blocked={blocked}
      dialMode={health?.dial_mode ?? "unknown"}
      defaultAssistant={null}
    />
  );
}
