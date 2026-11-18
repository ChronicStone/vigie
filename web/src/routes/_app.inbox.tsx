import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useRowKeys } from "@web/components/reliability.tsx";
import { DataLink, Empty, Levels, Load } from "@web/components/ui.tsx";
import { inboxFn, markReadFn } from "@web/fns/reliability.ts";
import { useAct, useFn } from "@web/lib/api.ts";
import { ago, dayMonth, hm, span } from "@web/lib/format.ts";

const search = z.object({ f: z.enum(["all", "unread", "alert", "issue", "uptime"]).optional().catch(undefined) });
export const Route = createFileRoute("/_app/inbox")({ validateSearch: search, component: InboxPage });

type Row = Awaited<ReturnType<typeof inboxFn>>["rows"][number];
type Incident = { from: number; to: number | null };
/** One line: one thing, on one day, however many times it fired and recovered that day. */
type Line = { key: string; href: string; category: string; name: string; detail: string; day: number; last: number; ids: number[]; incidents: Incident[]; note: string; open: boolean };

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const OPENS = [/^(.*) is firing$/, /^(.*) is down$/];
const CLOSES = [/^(.*) recovered$/, /^(.*) is back up$/];
const NOTES: [RegExp, string][] = [[/^New issue: (.*)$/, "New"], [/^(.*) came back$/, "Came back"]];

function subject(title: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1]!;
  }
  return null;
}

/** Fired and recovered belong together, so events are paired oldest first, then gathered per thing and per day. */
function linesOf(rows: Row[], firing: string[], down: string[]) {
  const oldestFirst = [...rows].sort((a, b) => a.at - b.at);
  const lines = new Map<string, Line>();
  const openIncident = new Map<string, { incident: Incident; line: Line }>();
  const lineFor = (row: Row, name: string, day: number, detail: string, note = "") => {
    const key = `${row.href ?? row.title}|${name}|${day}|${note}`;
    let line = lines.get(key);
    if (!line) {
      line = { key, href: row.href ?? "/inbox", category: row.category, name, detail, day, last: row.at, ids: [], incidents: [], note, open: false };
      lines.set(key, line);
    }
    line.last = Math.max(line.last, row.at);
    line.ids.push(row.id);
    return line;
  };
  for (const row of oldestFirst) {
    const opened = subject(row.title, OPENS);
    const closed = subject(row.title, CLOSES);
    if (opened) {
      const line = lineFor(row, opened, startOfDay(row.at), row.detail ?? "");
      const incident: Incident = { from: row.at, to: null };
      line.incidents.push(incident);
      openIncident.set(`${row.href}|${opened}`, { incident, line });
    } else if (closed) {
      const pair = openIncident.get(`${row.href}|${closed}`);
      if (pair) {
        pair.incident.to = row.at;
        pair.line.ids.push(row.id);
        pair.line.last = Math.max(pair.line.last, row.at);
        openIncident.delete(`${row.href}|${closed}`);
      } else {
        // The start is older than what is kept: say what is known, without inventing a duration.
        const line = lineFor(row, closed, startOfDay(row.at), row.detail ?? "");
        line.incidents.push({ from: row.at, to: row.at });
      }
    } else {
      const noted = NOTES.map(([pattern, note]) => [row.title.match(pattern)?.[1], note] as const).find(([name]) => name);
      lineFor(row, noted?.[0] ?? row.title, startOfDay(row.at), row.detail ?? "", noted?.[1] ?? "");
    }
  }
  // The stored state decides what is still open: an alert paused while firing never writes "recovered".
  for (const { line } of openIncident.values()) line.open = firing.includes(line.href) || down.includes(line.name);
  return [...lines.values()].sort((a, b) => b.last - a.last);
}

const dayTitle = (day: number) => {
  const today = startOfDay(Date.now());
  if (day === today) return "Today";
  if (day === startOfDay(today - DAY)) return "Yesterday";
  return dayMonth(day);
};
const timeOf = (line: Line) => (line.day === startOfDay(Date.now()) ? ago(line.last) : hm(line.last));

/** Where in the day it happened, on a line that runs from midnight to midnight. */
function DayTrack({ line }: { line: Line }) {
  const now = Date.now();
  const end = line.day + DAY;
  return (
    <span className="inbox-track" aria-hidden="true">
      {line.day <= now && now < end && <i className="inbox-now" style={{ left: `${((now - line.day) / DAY) * 100}%` }} />}
      {line.incidents.map((incident) => {
        const left = ((incident.from - line.day) / DAY) * 100;
        const stop = Math.min(incident.to ?? now, end);
        return <b key={incident.from} className={incident.to === null && line.open ? "open" : ""} style={{ left: `${left}%`, width: `max(3px, ${((stop - incident.from) / DAY) * 100}%)` }} title={`${hm(incident.from)} to ${incident.to === null ? "now" : hm(incident.to)}`} />;
      })}
    </span>
  );
}

function State({ line }: { line: Line }) {
  if (line.note) return <span className={line.note === "Came back" ? "err" : "warn"}>{line.note}</span>;
  const latest = line.incidents[line.incidents.length - 1];
  if (!latest) return null;
  const word = line.category === "uptime" ? "Down" : "Firing";
  const back = line.category === "uptime" ? "Back up" : "Recovered";
  if (line.open) return <span className="err">{word} for {span(Date.now() - latest.from)}</span>;
  if (latest.to === null) return <span className="t3">No recovery recorded</span>;
  return <span className="t3">{back}{latest.to > latest.from ? ` after ${span(latest.to - latest.from)}` : ""}</span>;
}

function InboxLine({ line, unread, onRead }: { line: Line; unread: boolean; onRead: (line: Line) => void }) {
  const times = line.incidents.length;
  return (
    <DataLink data-row className={`inbox-line ${unread ? "unread" : ""}`} to={line.href} onClick={() => onRead(line)}>
      {unread
        ? <button className="inbox-mark" type="button" aria-label={`Mark ${line.name} as read`} title="Mark as read" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRead(line); }}><i /></button>
        : <span className="inbox-mark" />}
      <span className="inbox-what">
        <span className="inbox-name">{line.name}</span>
        {line.detail && line.detail.toLowerCase() !== line.name.toLowerCase() && <span className="inbox-detail">{line.detail}</span>}
      </span>
      {times > 0 && <DayTrack line={line} />}
      <span className="inbox-times">{times > 1 ? `${times} times` : ""}</span>
      <span className="inbox-state"><State line={line} /></span>
      <span className="inbox-when">{timeOf(line)}</span>
    </DataLink>
  );
}

function InboxPage() {
  const { f = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Every event comes down once: filters only change what is shown, so they answer at once and fired can always pair with recovered.
  const q = useFn(inboxFn, {});
  const read = useAct(markReadFn);
  // Read means read the moment it is clicked. The server catches up behind it.
  const [justRead, setJustRead] = useState<Set<number>>(() => new Set());
  const [allRead, setAllRead] = useState(false);
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const lines = useMemo(() => linesOf(rows, q.data?.firing ?? [], q.data?.down ?? []), [rows, q.data]);
  useRowKeys();
  const unreadIds = useMemo(() => new Set(rows.filter((r) => !r.read_at && !allRead && !justRead.has(r.id)).map((r) => r.id)), [rows, justRead, allRead]);
  const isUnread = (line: Line) => line.ids.some((id) => unreadIds.has(id));
  const onRead = (line: Line) => {
    const ids = line.ids.filter((id) => unreadIds.has(id));
    if (!ids.length) return;
    setJustRead((prev) => new Set([...prev, ...ids]));
    read.mutate({ ids });
  };
  return (
    <Load q={q}>
      {() => {
        const unreadLines = lines.filter(isUnread);
        const shown = lines.filter((line) => (f === "all" ? true : f === "unread" ? isUnread(line) : line.category === f));
        const open = shown.filter((line) => line.open);
        const rest = shown.filter((line) => !line.open);
        const days = [...new Set(rest.map((line) => line.day))];
        const count = (category: string) => lines.filter((line) => line.category === category).length;
        const options = ([["all", "All"], ["unread", <>Unread <b>{unreadLines.length}</b></>], ["alert", <>Alerts <b>{count("alert")}</b></>], ["issue", <>Issues <b>{count("issue")}</b></>], ["uptime", <>Uptime <b>{count("uptime")}</b></>]] as const).filter(([key]) => key === f || key === "all" || (key === "unread" ? unreadLines.length > 0 : count(key) > 0));
        return (
          <>
            <div className="subbar">
              <Levels value={f} onChange={(value) => void navigate({ search: (prev) => ({ ...prev, f: value === "all" ? undefined : value }), replace: true })} options={options as never} />
              <span className="grow" />
              {unreadLines.length > 0 && <button className="btn" onClick={() => { setAllRead(true); read.mutate({}); }}>Mark all read</button>}
            </div>
            <div className="ov inbox">
              {!lines.length && <Empty title="Nothing has happened yet" hint="Alerts that fire, issues that are new or come back, and monitors that go down land here." />}
              {lines.length > 0 && !shown.length && (
                <Empty title={f === "unread" ? "You have read everything" : "Nothing here"}>
                  <button className="btn" style={{ marginTop: 12 }} onClick={() => void navigate({ search: (prev) => ({ ...prev, f: undefined }), replace: true })}>Show all</button>
                </Empty>
              )}
              {open.length > 0 && (
                <section className="inbox-open" aria-label="Still happening">
                  <div className="inbox-dayh"><h3>Still happening</h3><span className="inbox-hours" aria-hidden="true"><span>00</span><span>12</span><span>24</span></span></div>
                  {open.map((line) => <InboxLine key={line.key} line={line} unread={isUnread(line)} onRead={onRead} />)}
                </section>
              )}
              {days.map((day) => (
                <section key={day}>
                  <div className="inbox-dayh"><h3>{dayTitle(day)}</h3>{rest.some((line) => line.day === day && line.incidents.length > 0) && <span className="inbox-hours" aria-hidden="true"><span>00</span><span>12</span><span>24</span></span>}</div>
                  {rest.filter((line) => line.day === day).map((line) => <InboxLine key={line.key} line={line} unread={isUnread(line)} onRead={onRead} />)}
                </section>
              ))}
            </div>
          </>
        );
      }}
    </Load>
  );
}
