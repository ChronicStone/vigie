import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { share, useListKeys } from "@web/components/backend.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { mapFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, shortService } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/map")({ component: MapPage });

const COLOR = { app: "var(--app)", database: "var(--db)", cache: "var(--cache)", external: "var(--ext)" } as const;
const GROUP: Record<string, string> = { database: "Database", cache: "Cache", external: "Providers", app: "Other services" };
type Kind = keyof typeof COLOR;

/** A rate this small is a blip to look at, not a broken connection. */
const FAILING = 5;
const toneOf = (calls: number, errors: number) => {
  if (!errors) return "";
  return (errors / Math.max(calls, 1)) * 100 >= FAILING ? "err" : "warn";
};

const NODE_H = 50;
const GAP = 6;
const GROUP_H = 26;
/** The canvas is 1000 wide in its own units and stretches with the panel, so nodes sit in percent and edges in the same units. */
const LEFT = { x: 20, w: 240 };
const RIGHT = { x: 660, w: 320 };

function NodeLink({ kind, host, children, className, style, onEnter, onLeave }: { kind: Kind; host: string; children: ReactNode; className: string; style: React.CSSProperties; onEnter: () => void; onLeave: () => void }) {
  const events = { className, style, onPointerEnter: onEnter, onPointerLeave: onLeave, onFocus: onEnter, onBlur: onLeave };
  if (kind === "external") return <Link {...events} to="/external/$host" params={{ host }}>{children}</Link>;
  if (kind === "database") return <Link {...events} to="/queries">{children}</Link>;
  if (kind === "cache") return <Link {...events} to="/cache">{children}</Link>;
  return <Link {...events} to="/services">{children}</Link>;
}

function MapPage() {
  const q = useScoped(mapFn, {});
  const [hover, setHover] = useState<string | null>(null);
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        if (!d.services.length || !d.edges.length) return <Empty title="Nothing to draw yet" hint="The map comes from spans that call a database, a cache or another host." />;
        const callees = new Map<string, { id: string; label: string; kind: Kind; calls: number; errors: number }>();
        for (const edge of d.edges) {
          const entry = callees.get(edge.callee) ?? { id: edge.callee, label: edge.name, kind: (edge.kind in COLOR ? edge.kind : "external") as Kind, calls: 0, errors: 0 };
          entry.calls += edge.calls;
          entry.errors += edge.errors;
          callees.set(edge.callee, entry);
        }
        const order: Kind[] = ["database", "cache", "external", "app"];
        const right: { y: number; node: (typeof callees extends Map<string, infer V> ? V : never) }[] = [];
        const heads: { y: number; label: string }[] = [];
        let y = 14;
        for (const kind of order) {
          const members = [...callees.values()].filter((c) => c.kind === kind).sort((a, b) => toneRank(a) - toneRank(b) || b.calls - a.calls);
          if (!members.length) continue;
          heads.push({ y, label: GROUP[kind]! });
          y += GROUP_H;
          for (const node of members) {
            right.push({ y, node });
            y += NODE_H + GAP;
          }
          y += 10;
        }
        const height = y + 6;
        const callers = d.services.filter((s) => d.edges.some((e) => e.caller === s.name));
        const span = callers.length * NODE_H + (callers.length - 1) * 40;
        const start = Math.max(14, (height - span) / 2);
        const left = callers.map((s, i) => ({ y: start + i * (NODE_H + 40), s }));
        const at = new Map<string, number>([...left.map((n) => [n.s.name, n.y] as const), ...right.map((n) => [n.node.id, n.y] as const)]);
        const maxCalls = Math.max(1, ...d.edges.map((e) => e.calls));
        const edges = [...d.edges].sort((a, b) => toneValue(a.calls, a.errors) - toneValue(b.calls, b.errors));
        const ranked = [...d.edges].sort((a, b) => b.errors / Math.max(b.calls, 1) - a.errors / Math.max(a.calls, 1) || b.calls - a.calls);
        return (
          <div className="ov">
            <div className="map-canvas" style={{ height }}>
              <svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" aria-hidden="true">
                {edges.map((edge) => {
                  const y1 = at.get(edge.caller);
                  const y2 = at.get(edge.callee);
                  if (y1 === undefined || y2 === undefined) return null;
                  const x1 = LEFT.x + LEFT.w;
                  const x2 = RIGHT.x;
                  const mid = (x1 + x2) / 2;
                  const tone = toneOf(edge.calls, edge.errors);
                  const touched = hover === null || hover === edge.caller || hover === edge.callee;
                  // Thickness on a log scale: otherwise the database hides every provider.
                  const width = 1 + (Math.log10(edge.calls + 1) / Math.log10(maxCalls + 1)) * 2.5;
                  return <path key={edge.caller + edge.callee} className={`map-edge ${tone} ${touched ? "" : "dim"}`} d={`M${x1},${y1 + NODE_H / 2} C${mid},${y1 + NODE_H / 2} ${mid},${y2 + NODE_H / 2} ${x2},${y2 + NODE_H / 2}`} strokeWidth={width} vectorEffect="non-scaling-stroke" fill="none" />;
                })}
              </svg>
              {heads.map((head) => <span key={head.label} className="map-group" style={{ left: `${RIGHT.x / 10}%`, top: head.y }}>{head.label}</span>)}
              {left.map(({ s, y: top }) => (
                <NodeLink key={s.name} kind="app" host={s.name} className={`map-node ${hover === s.name ? "on" : ""}`} style={{ left: `${LEFT.x / 10}%`, width: `${LEFT.w / 10}%`, top, height: NODE_H }} onEnter={() => setHover(s.name)} onLeave={() => setHover(null)}>
                  <b>{shortService(s.name)}</b>
                  <span className="t3 mono">{compact(s.events)} events</span>
                </NodeLink>
              ))}
              {right.map(({ node, y: top }) => {
                const tone = toneOf(node.calls, node.errors);
                return (
                  <NodeLink key={node.id} kind={node.kind} host={node.id} className={`map-node ${hover === node.id ? "on" : ""}`} style={{ left: `${RIGHT.x / 10}%`, width: `${RIGHT.w / 10}%`, top, height: NODE_H }} onEnter={() => setHover(node.id)} onLeave={() => setHover(null)}>
                    <b>{node.label}</b>
                    <span className="mono"><span className="t3">{compact(node.calls)} {node.kind === "database" ? "queries" : "calls"}</span>{tone && <span className={tone}>, {share(node.errors, node.calls)} failed</span>}</span>
                  </NodeLink>
                );
              })}
            </div>
            <section className="rt-list">
              <h3>Connections</h3>
              {ranked.map((edge) => {
                const tone = toneOf(edge.calls, edge.errors);
                const kind = (edge.kind in COLOR ? edge.kind : "external") as Kind;
                const body = (
                  <>
                    <span className="map-from">{shortService(edge.caller)}</span>
                    <span className="t4" aria-hidden="true">→</span>
                    <span className="grow ell">{edge.name}</span>
                    {tone && <span className={`mono ${tone}`}><span className="map-fn">{compact(edge.errors)} failed, </span>{share(edge.errors, edge.calls)}</span>}
                    <span className="mono t3 map-calls">{compact(edge.calls)}</span>
                  </>
                );
                if (kind === "external") return <Link key={edge.caller + edge.callee} className="lst" to="/external/$host" params={{ host: edge.callee }}>{body}</Link>;
                if (kind === "database") return <Link key={edge.caller + edge.callee} className="lst" to="/queries">{body}</Link>;
                if (kind === "cache") return <Link key={edge.caller + edge.callee} className="lst" to="/cache">{body}</Link>;
                return <Link key={edge.caller + edge.callee} className="lst" to="/services">{body}</Link>;
              })}
            </section>
          </div>
        );
      }}
    </Load>
  );
}

const toneValue = (calls: number, errors: number) => (toneOf(calls, errors) === "err" ? 2 : errors ? 1 : 0);
const toneRank = (node: { calls: number; errors: number }) => 2 - toneValue(node.calls, node.errors);
