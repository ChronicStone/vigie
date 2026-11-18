import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Hl } from "@web/components/code.tsx";
import { Choice } from "@web/components/form.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { toast } from "@web/components/toast.tsx";
import { Card, Chip, Confirm, Entry, Head, Load } from "@web/components/ui.tsx";
import { issueFn, linearIssueFn, muteIssuesFn, unmuteFn, updateIssueFn } from "@web/fns/reliability.ts";
import { errorText, useAct, useScoped } from "@web/lib/api.ts";
import { ago, dayMonth, hm, num, shortService } from "@web/lib/format.ts";
import { PRIORITY } from "@web/lib/labels.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/issues/$fp")({ component: IssuePage });

type Detail = Awaited<ReturnType<typeof issueFn>>;
type Activity = Detail["activity"][number];

const SEEN = [{ key: "error", label: "Occurrences", color: "var(--err)" }];

function Stack({ stack }: { stack: string }) {
  const lines = stack.split("\n");
  const frames = lines.slice(1).map((l) => l.trim().replace(/^at /, "")).filter(Boolean);
  const mine = frames.filter((f) => !f.includes("node_modules") && !f.startsWith("node:"));
  return (
    <div className="issue-stack">
      {mine.map((frame, i) => {
        const match = frame.match(/^(.*?) \((.*)\)$/);
        return <div className={`frame ${i === 0 ? "first" : ""}`} key={`${frame}${i}`}><span className="issue-place"><Hl lang="place">{match?.[2] ?? frame}</Hl></span>{match && <span className="t4 ell">{match[1]}</span>}</div>;
      })}
      {frames.length > mine.length && <div className="frame t4">{frames.length - mine.length} more {frames.length - mine.length === 1 ? "frame" : "frames"} in dependencies and Node internals</div>}
    </div>
  );
}

/** Repeats say nothing new: the same action in a row is one line, and resolving back and forth is one line too. */
const FLIPS = new Set(["Resolved", "Reopened"]);
type ActivityLine = { key: number; text: ReactNode; title?: string; at: number };
function collapse(items: Activity[]): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i]!;
    if (item.note && item.action === "Commented") {
      lines.push({ key: item.id, text: <><b>{item.actor}</b> {item.note}</>, title: item.note, at: item.at });
      i++;
      continue;
    }
    let end = i + 1;
    const same = (other: Activity) => other.actor === item.actor && !other.note && (other.action === item.action || (FLIPS.has(item.action) && FLIPS.has(other.action)));
    while (end < items.length && !item.note && same(items[end]!)) end++;
    const count = end - i;
    const mixed = items.slice(i, end).some((other) => other.action !== item.action);
    const text = mixed ? `Resolved and reopened ${count} times` : `${item.action}${count > 1 ? ` ${count} times` : ""}${item.note ? `: ${item.note}` : ""}`;
    lines.push({ key: item.id, text: <>{text}, {item.actor}</>, title: item.note ?? undefined, at: item.at });
    i = end;
  }
  return lines;
}

function ActivityList({ items }: { items: Activity[] }) {
  const [all, setAll] = useState(false);
  const lines = collapse(items);
  const shown = all ? lines : lines.slice(0, 5);
  return (
    <>
      {shown.map((line) => <div className="lst issue-act" key={line.key} title={line.title}><span className="grow ell">{line.text}</span><span className="t3">{ago(line.at)}</span></div>)}
      {lines.length > 5 && <button className="tlink issue-more" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${lines.length}`}</button>}
    </>
  );
}

function IssuePage() {
  const { fp } = Route.useParams();
  const scope = useScope();
  const q = useScoped(issueFn, { fp });
  const update = useAct(updateIssueFn);
  const muteIssues = useAct(muteIssuesFn);
  const unmuteIssue = useAct(unmuteFn);
  const linear = useAct(linearIssueFn);
  const [muteReason, setMuteReason] = useState("");
  const act = (data: Omit<Parameters<typeof updateIssueFn>[0]["data"], "fp">, done: string) => update.mutate({ fp, ...data }, { onSuccess: () => toast(done), onError: (error) => toast(errorText(error)) });
  const form = useForm({
    defaultValues: { comment: "" },
    onSubmit: ({ value, formApi }) => {
      if (!value.comment.trim()) return;
      act({ comment: value.comment }, "Comment added");
      formApi.reset();
    },
  });
  return (
    <Load q={q}>
      {(d) => {
        const accountMax = Math.max(1, ...d.accounts.map((a) => a.n));
        return (
          <div className="ov issue">
            <Head back="/issues" backTitle="Back to issues" mono title={d.name} meta={<><Chip tone={d.regressed ? "err" : d.status === "resolved" ? "ok" : d.status === "archived" ? "t3" : "warn"}>{d.regressed ? "Came back" : d.status === "open" ? "Open" : d.status === "resolved" ? "Resolved" : "Archived"}</Chip>{d.muteRule && <Chip tone="t3">Muted</Chip>}<Choice label="Priority" className="fchip" value={d.priority} onChange={(priority) => act({ priority }, `Priority set to ${priority}`)} options={Object.entries(PRIORITY).map(([key, value]) => [key as "high" | "medium" | "low", `${value[0]} priority`] as const)} /></>} right={<>
              {d.linear_url ? <a className="btn" href={d.linear_url} target="_blank" rel="noreferrer">Open in Linear</a> : d.linearReady && <button className="btn" disabled={linear.isPending} onClick={() => linear.mutate({ fp }, { onSuccess: () => toast("Filed in Linear"), onError: (error) => toast(errorText(error)) })}>Create Linear issue</button>}
              {d.muteRule ? <button className="btn" onClick={() => unmuteIssue.mutate({ id: d.muteRule!.id }, { onSuccess: () => toast("No longer muted") })}>Unmute</button> : <Confirm trigger={<button className="btn">Mute</button>} title={`Mute issues like ${d.name}?`} action="Mute" onConfirm={async () => { await muteIssues.mutateAsync({ fp, reason: muteReason }); setMuteReason(""); toast("Muted. Events are still stored."); }}><p className="t2" style={{ marginBottom: 10 }}>They leave the list and post nothing. Their events are still stored.</p><input className="input" aria-label="Why this is muted" placeholder="Why" autoFocus value={muteReason} onChange={(e) => setMuteReason(e.target.value)} /></Confirm>}
              {d.status === "open" ? (
                <>
                  <button className="btn" onClick={() => act({ status: "archived", days: 1 }, "Archived for 1 day")}>Archive</button>
                  <button className="btn pri" onClick={() => act({ status: "resolved" }, "Issue resolved. It reopens if it fires again.")}>Resolve</button>
                </>
              ) : (
                <button className="btn" onClick={() => act({ status: "open" }, "Reopened")}>Reopen</button>
              )}
            </>} />

            <div className="issue-lede">
              <p className="issue-message">{d.message}</p>
              <p className="issue-facts">
                <span><b>{num(d.people)}</b> {d.people === 1 ? "person" : "people"}</span>
                {d.accounts.length > 0 && <span><b>{d.accounts.length}{d.accounts.length === 12 ? "+" : ""}</b> {d.accounts.length === 1 ? "account" : "accounts"}</span>}
                <span>First seen <b>{dayMonth(d.first_seen)}, {hm(d.first_seen)}</b></span>
                <span>Last seen <b>{ago(d.last_seen)}</b></span>
                <span className="issue-entry"><Entry text={d.entry} /></span>
                <span>{shortService(d.service)}</span>
                {d.assignee && <span>Assigned to <b>{d.assignee}</b></span>}
              </p>
              {d.muteRule && <p className="issue-note">Muted because: {d.muteRule.reason}</p>}
              {d.regressed_in && <p className="issue-note err">Came back in release <span className="mono">{d.regressed_in}</span>.</p>}
              {/* Whether a fix held only means something while the issue stands resolved. Once reopened, only a return is news. */}
              {d.status === "resolved" && d.verification?.state === "fixed" && <p className="issue-note"><b className="ok">The fix held.</b> Nothing since it was resolved, across {d.verification.shipped.length === 1 ? "version" : "versions"} {d.verification.shipped.join(", ")}.</p>}
              {d.status === "resolved" && d.verification?.state === "waiting" && <p className="issue-note"><b>Not proven yet.</b> Quiet since it was resolved, but no new version has shipped.</p>}
              {d.verification?.state === "came-back" && <p className="issue-note"><b className="err">It came back.</b> {num(d.verification.events)} {d.verification.events === 1 ? "event" : "events"} since it was resolved{d.verification.cameBackIn ? `, first in version ${d.verification.cameBackIn}` : ""}.</p>}
            </div>

            {(d.why || d.fix) && (
              <div className="issue-fix">
                {d.why && <div><h3>Why it happens</h3><p>{d.why}</p></div>}
                {d.fix && <div><h3>How to fix it</h3><p>{d.fix}{d.link && <> <a className="lnk" href={d.link} target="_blank" rel="noreferrer">Read more</a></>}</p></div>}
              </div>
            )}

            {d.inRange > 0
              ? <Lanes from={scope.from} to={scope.to} height={64} lanes={[{ id: "seen", label: "Occurrences", data: d.series, keys: SEEN, figures: [{ value: num(d.inRange), label: scope.custom ? "In this window" : `Last ${scope.range}` }, { value: num(d.events), label: "Ever" }] }]} />
              : <p className="issue-quiet">No occurrence {scope.custom ? "in this window" : `in the last ${scope.range}`}. {num(d.events)} ever, last seen {ago(d.last_seen)}.</p>}

            <div className="issue-grid">
              <Card title="Where it was thrown" right={d.latest ? (d.latest.taskId ? <Link className="lnk" to="/tasks/run/$id" params={{ id: d.latest.taskId }}>Latest occurrence</Link> : d.latest.traceId ? <Link className="lnk" to="/traces/$id" params={{ id: d.latest.traceId }}>Latest occurrence</Link> : undefined) : undefined}>
                {d.source && (
                  <div className="srcv">
                    <a className="lnk mono" href={d.source.url} target="_blank" rel="noreferrer">{d.source.path}:{d.source.line}</a>
                    <pre>{d.source.lines.map((line) => <div key={line.n} className={line.n === d.source!.line ? "hit" : ""}><i>{line.n}</i><Hl lang="ts">{line.text || " "}</Hl></div>)}</pre>
                  </div>
                )}
                {d.stack || d.latest?.stack ? <Stack stack={d.stack || d.latest!.stack} /> : <div className="cb t3">This error carries no stack.</div>}
              </Card>
              <Card title="Affected accounts">
                {d.accounts.map((a) => (
                  <div className="issue-account" key={a.id}>
                    <span className="ell">{a.name}</span>
                    <span className="mono t2">{num(a.n)}</span>
                    <span className="share bad"><i style={{ scale: `${a.n / accountMax} 1` }} /></span>
                  </div>
                ))}
                {!d.accounts.length && <div className="cb t3">No account on these events.</div>}
              </Card>
            </div>
            <Card title="Activity">
              <ActivityList items={d.activity} />
              <form className="cb issue-comment" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
                <form.Field name="comment">{(field) => <input className="input" placeholder="Add a comment" aria-label="Add a comment" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />}</form.Field>
              </form>
            </Card>
          </div>
        );
      }}
    </Load>
  );
}
