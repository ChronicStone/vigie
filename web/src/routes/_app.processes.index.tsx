import { createFileRoute, Link } from "@tanstack/react-router";
import { useListKeys } from "@web/components/task-tabs.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { processListFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { num, span } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/processes/")({ component: ProcessesPage });

type Process = Awaited<ReturnType<typeof processListFn>>[number];

/** The share of everything started, by where it stands. Skips count as completed: a step that decided nothing was needed finished the job. */
function Progress({ p }: { p: Process }) {
  const whole = Math.max(p.started, 1);
  const part = (n: number) => `${(n / whole) * 100}%`;
  return (
    <span className="processes-bar" aria-hidden="true">
      <i className="is-done" style={{ width: part(p.completed) }} />
      <i className="is-open" style={{ width: part(p.running) }} />
      <i className="is-stuck" style={{ width: part(p.stuck) }} />
      <i className="is-failed" style={{ width: part(p.failed) }} />
    </span>
  );
}

/** The flow's shape at a glance: a dot per step, side by side when they run together, coloured where things pile up. */
function Mini({ p }: { p: Process }) {
  return (
    <span className="processes-mini" aria-hidden="true">
      {p.steps.map((group, i) => (
        <span key={i} className="processes-mini-g">
          {group.map((step) => <i key={step.kind} title={step.label} className={step.held ? (p.failed ? "is-err" : "is-warn") : step.reached ? "is-on" : ""} />)}
        </span>
      ))}
    </span>
  );
}

function ProcessesPage() {
  const q = useScoped(processListFn, {});
  useListKeys({ rows: ".processes-row" });
  return (
    <Load q={q}>
      {(rows) => {
        if (!rows.length) return <Empty title="No process defined yet" hint="Add one under definitions/processes with defineProcess." />;
        const weight = (p: Process) => (p.failed ? 0 : p.stuck ? 1 : 2);
        const active = rows.filter((p) => p.started > 0).sort((a, b) => weight(a) - weight(b) || b.started - a.started);
        const quiet = rows.filter((p) => p.started === 0);
        return (
          <div className="ov processes">
            {active.map((p) => (
              <Link key={p.id} className="processes-row" to="/processes/$id" params={{ id: p.id }}>
                <span className="processes-name">
                  <b>{p.title}</b>
                  <span>{p.steps.flat().length} {p.steps.flat().length === 1 ? "step" : "steps"}, from {p.subject}{p.typical >= 1000 ? `, typically ${span(p.typical)}` : ""}</span>
                </span>
                <span className="processes-progress">
                  <Progress p={p} />
                  <span className="processes-counts"><b>{num(p.completed)}</b> of {num(p.started)} completed{p.running > 0 && <>, {num(p.running)} still open</>}</span>
                </span>
                <span className="processes-pile">
                  {p.pile ? (
                    <>
                      <b className={p.failed ? "err" : "warn"}>{[p.stuck ? `${num(p.stuck)} stuck` : "", p.failed ? `${num(p.failed)} failed` : ""].filter(Boolean).join(", ")}</b>
                      <span>at {p.pile.label}</span>
                    </>
                  ) : (
                    <span className="t3">Nothing stuck</span>
                  )}
                </span>
                <Mini p={p} />
              </Link>
            ))}
            {quiet.length > 0 && (
              <div className="processes-quiet">
                <span>Nothing started in this window</span>
                <div>{quiet.map((p) => <Link key={p.id} to="/processes/$id" params={{ id: p.id }}>{p.title}</Link>)}</div>
              </div>
            )}
          </div>
        );
      }}
    </Load>
  );
}
