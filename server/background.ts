import { evaluateAlerts } from "./alerts.ts";
import { pushInbox } from "./alerts.ts";
import { runMonitors } from "./api/uptime.ts";
import { mirrorOnce } from "./mirror.ts";
import { db } from "./state/db.ts";

let lastIssueCheck = Date.now();

function issueNotifications() {
  const rows = db.query<any, [number]>("SELECT fingerprint, name, message, regressed, regressed_in, first_seen, last_seen, priority FROM issues WHERE last_seen > ? AND status = 'open'").all(lastIssueCheck);
  for (const row of rows) {
    if (row.regressed) pushInbox("issue", `${row.name} came back`, row.regressed_in ? `In release ${row.regressed_in}` : row.message, `/issues/${row.fingerprint}`, `reg:${row.fingerprint}:${row.regressed_in}`);
    else if (row.first_seen > lastIssueCheck) pushInbox("issue", `New issue: ${row.name}`, row.message, `/issues/${row.fingerprint}`, `new:${row.fingerprint}`);
  }
  lastIssueCheck = Date.now();
}

export function startBackground() {
  const tick = () => {
    evaluateAlerts().catch((error) => console.error("Alert evaluation failed:", error));
    issueNotifications();
  };
  setTimeout(tick, 2000);
  setInterval(tick, 30_000);
  let mirroring = false;
  setInterval(() => {
    if (mirroring) return;
    mirroring = true;
    mirrorOnce()
      .catch((error) => console.error("Task mirror failed:", error))
      .finally(() => (mirroring = false));
  }, 5000);
  if (process.env.VIGIE_UPTIME === "off") return;
  const monitors = () => runMonitors().catch((error) => console.error("Uptime checks failed:", error));
  setTimeout(monitors, 3000);
  setInterval(monitors, 60_000);
}
