import { createFileRoute, Link } from "@tanstack/react-router";
import { Empty, Load, Method2 } from "@web/components/ui.tsx";
import { rulesFn } from "@web/fns/reliability.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, num } from "@web/lib/format.ts";
import { useScope, useSetScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/rules")({ component: RulesPage });

type Rule = Awaited<ReturnType<typeof rulesFn>>[number];

/** A rule's name is already a sentence. Only the thing it names reads as code. */
function Sentence({ text }: { text: string }) {
  const request = text.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(.*)$/);
  if (request) return <><Method2 m={request[1]!} /><span className="rules-code">{request[2]}</span>{request[3]}</>;
  const task = text.match(/^Task\s+(\S+)(.*)$/);
  if (task) return <>Task <span className="rules-code">{task[1]}</span>{task[2]}</>;
  return <>{text}</>;
}

const unitOf = (rule: Rule, n: number) => (rule.entry.taskKind ? (n === 1 ? "run" : "runs") : n === 1 ? "request" : "requests");

/** How many were checked, linked to those when they have a page. */
function Checked({ rule }: { rule: Rule }) {
  const label = <>{compact(rule.checked)} {unitOf(rule, rule.checked)}</>;
  if (rule.entry.taskKind) return <Link className="rules-set" to="/tasks/kind/$kind" params={{ kind: rule.entry.taskKind }}>{label}</Link>;
  if (rule.entry.route) return <Link className="rules-set" to="/requests/route" search={{ method: rule.entry.method ?? "", route: rule.entry.route }}>{label}</Link>;
  return label;
}

function Broken({ rule }: { rule: Rule }) {
  const share = rule.checked ? Math.min(100, (rule.violated / rule.checked) * 100) : 0;
  const body = (
    <>
      <p className="rules-sentence"><Sentence text={rule.name} /></p>
      <div className="rules-count">
        <b>{num(rule.violated)}</b>
        <span>of {compact(rule.checked)} {unitOf(rule, rule.checked)} broke it, last {ago(rule.last)}</span>
        {rule.traceId && <span className="rules-open">Open the latest</span>}
      </div>
      <span className="rules-share" aria-hidden="true"><i style={{ scale: `${Math.max(share, 0.6) / 100} 1` }} /></span>
    </>
  );
  return rule.traceId ? <Link data-row className="rules-broken" to="/traces/$id" params={{ id: rule.traceId }}>{body}</Link> : <div className="rules-broken">{body}</div>;
}

function RulesPage() {
  const q = useScoped(rulesFn, {});
  const scope = useScope();
  const setScope = useSetScope();
  const window = scope.custom ? "in this window" : `in the last ${scope.range}`;
  return (
    <Load q={q}>
      {(rows) => {
        if (!rows.length) return <Empty title="No rule defined yet" hint="Add rules to definitions/catalog: what a request or a task must never do, such as a limit on its queries." />;
        const broken = rows.filter((r) => r.state === "violated").sort((a, b) => b.violated - a.violated);
        const holding = rows.filter((r) => r.state === "holding");
        const unchecked = rows.filter((r) => r.state === "unchecked");
        return (
          <>
            <div className="subbar rules-bar">
              <span className={`rules-answer ${broken.length ? "err" : ""}`}>
                {broken.length === 1 ? "1 rule was broken" : broken.length ? `${broken.length} rules were broken` : holding.length === 1 ? "1 rule holds" : holding.length ? `${holding.length} rules hold` : "Nothing ran that these rules watch"}
                <span className="t3"> {window}</span>
              </span>
            </div>
            <div className="ov rules">
              {broken.length > 0 && <section className="rules-group">{broken.map((rule) => <Broken key={rule.id} rule={rule} />)}</section>}
              {holding.length > 0 && (
                <section className="rules-group">
                  <h3>Holding</h3>
                  {holding.map((rule) => (
                    <div className="rules-held" key={rule.id}>
                      <p className="rules-sentence"><Sentence text={rule.name} /></p>
                      <span className="rules-seen">Held across <Checked rule={rule} /></span>
                    </div>
                  ))}
                </section>
              )}
              {unchecked.length > 0 && (
                <section className="rules-group rules-unchecked">
                  <h3>Not checked</h3>
                  <p className="rules-why">Nothing these rules watch ran {window}, so they say nothing either way.{scope.range !== "7d" && scope.range !== "30d" && <> <button className="tlink" onClick={() => setScope({ range: "7d", from: undefined, to: undefined })}>Check the last 7 days</button></>}</p>
                  {unchecked.map((rule) => <p className="rules-sentence" key={rule.id}><Sentence text={rule.name} /></p>)}
                </section>
              )}
            </div>
          </>
        );
      }}
    </Load>
  );
}
