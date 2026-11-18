import { environments, ENV_LABEL } from "@web/lib/scope.ts";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import { z } from "zod";
import { Choice, TextField } from "@web/components/form.tsx";
import { Icon } from "@web/components/icons.tsx";
import { toast } from "@web/components/toast.tsx";
import { Avatar, Chip, Confirm, copy, CopyButton, Empty, Load, Pop, SearchBox, Sql } from "@web/components/ui.tsx";
import { cancelInviteFn, dropMemberFn, inviteMemberFn, addChannelFn, addTokenFn, changeRoleFn, dropTokenFn, reloadExtensionsFn, removeChannelFn, settingsAuditFn, settingsChannelsFn, settingsExtensionsFn, settingsMembersFn, settingsRedactionFn, settingsServicesFn, settingsStorageFn, settingsTokensFn, testChannelsFn, tryRedactionFn } from "@web/fns/admin.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";
import { ago, bytes, compact, dayMonth, hm, num } from "@web/lib/format.ts";

const search = z.object({ q: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/settings/$section")({ validateSearch: search, component: SettingsPage });

const SECTIONS: [string, [string, string][]][] = [
  ["Data", [["services", "Services and keys"], ["storage", "Retention and storage"], ["redaction", "Redaction"]]],
  ["Alerts", [["channels", "Notification channels"]]],
  ["Access", [["members", "Members and access"], ["tokens", "Tokens"], ["audit", "Audit log"]]],
  ["Code", [["extensions", "Extensions"]]],
];

function Part({ title, right, children, id }: { title?: ReactNode; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="home-part" id={id}>
      {(title || right) && <header className="home-part-h"><h3>{title}</h3>{right && <span className="home-part-r">{right}</span>}</header>}
      {children}
    </section>
  );
}

const STALE = 60 * 60_000;

/** What is connected, and how to connect one more. */
function Services() {
  const q = useFn(settingsServicesFn, undefined);
  const [secret, setSecret] = useState("");
  const add = useAct(addTokenFn);
  return (
    <Load q={q}>
      {(d) => {
        const key = secret || d.keys[0]?.prefix || "vk_your_key";
        const local = d.mode === "local";
        const env = [`OTEL_EXPORTER_OTLP_ENDPOINT=${d.endpoint}`, ...(local ? [] : [`OTEL_EXPORTER_OTLP_HEADERS=authorization=${key}`])].join("\n");
        const names = [...new Set(d.services.map((service) => service.name))];
        const envs = environments().filter((code) => d.services.some((service) => service.environment === code));
        return (
          <>
            <Part title="Connected, last 24 hours">
              {names.length ? (
                <div className="home-svc" style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${Math.max(envs.length, 1)}, minmax(150px, 220px))` }}>
                  <span className="home-svc-th" />
                  {envs.map((code) => <span className="home-svc-th" key={code}>{ENV_LABEL[code]}</span>)}
                  {names.map((name) => (
                    <Fragment key={name}>
                      <span className="mono home-svc-name">{name}</span>
                      {envs.map((code) => {
                        const service = d.services.find((row) => row.name === name && row.environment === code);
                        return (
                          <span className="home-svc-v" key={code}>
                            <small className="home-ph">{ENV_LABEL[code]}</small>
                            {service ? <><b>{compact(service.events)}</b> <span className={Date.now() - service.last > STALE ? "warn" : "t3"}>{ago(service.last)}</span></> : <span className="t4">Nothing</span>}
                          </span>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              ) : <div className="home-part-b t3">Nothing has arrived in the last 24 hours. Point a service at the endpoint below.</div>}
            </Part>
            <Part title="Connect a service">
              <ol className="home-steps">
                {!local && (
                  <li>
                    <span className="home-step-n">1</span>
                    <div>Create a key. It is stored hashed and shown once.</div>
                    <div className="row"><button className="btn" onClick={() => add.mutate({ kind: "ingest", name: `Service key ${new Date().toISOString().slice(0, 10)}`, scope: "write" }, { onSuccess: (token) => { setSecret(token.secret); toast("Key created. Copy it now, it is shown once."); }, onError: (error) => toast(errorText(error)) })}>New ingest key</button>{d.keys.length > 0 && <Link className="lnk-quiet" to="/settings/$section" params={{ section: "tokens" }}>{d.keys.length} in use</Link>}</div>
                  </li>
                )}
                <li>
                  <span className="home-step-n">{local ? 1 : 2}</span>
                  <div>Give your service these variables.{local && <span className="t3"> Local mode accepts data without a key.</span>}</div>
                  <Sql text={env} lang="env" />
                  <div><CopyButton text={env} /></div>
                </li>
                <li><span className="home-step-n">{local ? 2 : 3}</span>Its first events show up above within seconds.</li>
              </ol>
            </Part>
            <Part title="Since this start">
              <p className="home-line">
                <b>{num(d.ingest.accepted.spans)}</b> spans, <b>{num(d.ingest.accepted.logs)}</b> logs, <b>{num(d.ingest.accepted.metrics)}</b> metrics accepted.{" "}
                <span className={d.ingest.rejected ? "err" : ""}><b>{num(d.ingest.rejected)}</b> rejected.</span>{" "}
                <span className={d.ingest.spooled ? "warn" : ""}><b>{num(d.ingest.spooled)}</b> on disk, waiting.</span>
              </p>
            </Part>
          </>
        );
      }}
    </Load>
  );
}

const SIGNAL_TONES = ["var(--a)", "var(--t2)", "var(--t3)", "var(--t4)"];

/** How much disk this takes, how long things stay, and where that ends up. */
function Storage() {
  const q = useFn(settingsStorageFn, undefined);
  return (
    <Load q={q}>
      {(d) => {
        const days = d.perDay > 0 ? d.total / d.perDay : 1;
        const signals = [...d.signals].sort((a, b) => b.bytes - a.bytes);
        // Each signal grows at its own pace until its retention starts dropping the oldest day.
        const settled = signals.reduce((sum, signal) => sum + (signal.bytes / days) * (Number.parseInt(signal.ttl, 10) || 0), 0);
        return (
          <>
            <Part title="Disk">
              <div className="home-disk">
                <p className="home-disk-now"><b>{bytes(d.total)}</b> used, growing <b>{bytes(d.perDay)}</b> a day.{settled > d.total && <> About <b>{bytes(settled)}</b> once every retention window is full.</>}</p>
                <div className="home-disk-bar" aria-hidden="true">
                  {signals.map((signal, i) => <i key={signal.label} style={{ flexGrow: Math.max(signal.bytes, 1), background: SIGNAL_TONES[i % SIGNAL_TONES.length] }} />)}
                </div>
              </div>
              <div className="home-table home-storage">
                <span className="th">Signal</span><span className="th">Kept</span><span className="th r">Rows a day</span><span className="th r">Rows</span><span className="th r">Disk</span>
                {signals.map((signal, i) => (
                  <Fragment key={signal.label}>
                    <span className="home-sig"><i style={{ background: SIGNAL_TONES[i % SIGNAL_TONES.length] }} />{signal.label}</span>
                    <span className="t2">{signal.ttl}</span>
                    <span className="r mono t2">{compact(signal.perDay)}</span>
                    <span className="r mono t3">{compact(signal.rows)}</span>
                    <span className="r mono">{bytes(signal.bytes)}</span>
                  </Fragment>
                ))}
              </div>
            </Part>
            <Part title="Right now">
              <p className="home-line">ClickHouse holds <b>{bytes(d.clickhouseRam)}</b> of memory, Vigie <b>{bytes(d.vigieRam)}</b>. The last write took <b>{d.lastFlushMs} ms</b>.</p>
            </Part>
          </>
        );
      }}
    </Load>
  );
}

const CHANNEL_KIND = { slack: "Slack", discord: "Discord", email: "E-mail", webhook: "Signed webhook" } as const;

/** Where alerts go, and proof that they arrive. */
function Channels() {
  const q = useFn(settingsChannelsFn, undefined);
  const add = useAct(addChannelFn);
  const remove = useAct(removeChannelFn);
  const test = useAct(testChannelsFn);
  const [secret, setSecret] = useState("");
  const [adding, setAdding] = useState(false);
  const results = test.data?.results ?? [];
  const form = useForm({
    defaultValues: { kind: "slack" as "slack" | "discord" | "webhook" | "email", name: "", target: "" },
    onSubmit: ({ value, formApi }) => add.mutate(value, { onSuccess: (result) => { if (result.secret) setSecret(result.secret); formApi.reset(); setAdding(false); toast("Channel added"); }, onError: (error) => toast(errorText(error)) }),
  });
  const addButton = (
    <Pop align="end" width={320} open={adding} onOpenChange={setAdding} trigger={<button className="btn pri"><Icon name="plus" />Add a channel</button>}>
      <form className="home-pop-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <form.Field name="kind">{(field) => <label className="field">Kind<span><Choice label="Kind" value={field.state.value} onChange={field.handleChange} options={[["slack", "Slack"], ["discord", "Discord"], ["email", "E-mail"], ["webhook", "Signed webhook"]]} /></span></label>}</form.Field>
        <form.Field name="name">{(field) => <TextField field={field} label="Name" placeholder="#alerts" autoFocus />}</form.Field>
        <form.Field name="target" validators={{ onChange: ({ value, fieldApi }) => (fieldApi.form.getFieldValue("kind") === "email" ? (/.+@.+/.test(value) ? undefined : "An e-mail address") : /^https?:\/\//.test(value) ? undefined : "A full URL") }}>{(field) => <TextField field={field} label="URL or address" placeholder="https://hooks.slack.com/services/…" />}</form.Field>
        <button className="btn pri" type="submit">Add channel</button>
      </form>
    </Pop>
  );
  return (
    <Load q={q}>
      {(rows) => (
        <>
          <Part title="Alerts go to" right={<>{rows.length > 0 && <button className="btn" disabled={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: (r) => toast(`Sent to ${r.sent} of ${r.results.length}`), onError: (error) => toast(errorText(error)) })}>{test.isPending ? "Sending…" : "Send a test"}</button>}{addButton}</>}>
            {secret && <div className="stmt home-secret">Signing secret, shown once. Requests follow the Standard Webhooks spec: verify webhook-signature with it.<br /><button type="button" className="lnk mono" onClick={() => copy(secret)}>{secret}</button></div>}
            {rows.map((c) => {
              const result = results.find((r) => r.name === c.name);
              return (
                <div className="lst home-lst" key={c.id}>
                  <span className="home-lst-main"><b className="ell">{c.name}</b><small className="t3">{CHANNEL_KIND[c.kind as keyof typeof CHANNEL_KIND] ?? c.kind}</small></span>
                  <span className="mono t3 grow ell home-lst-hide">{c.target.replace(/^(https:\/\/[^/]+\/).*/, "$1…")}</span>
                  {result && (result.ok ? <span className="home-ok"><Icon name="check" size={12} />Delivered</span> : <span className="err ell" title={result.error}>{result.error ?? "Not delivered"}</span>)}
                  <Confirm trigger={<button className="btn">Remove</button>} title={`Remove ${c.name}?`} action="Remove" danger onConfirm={() => remove.mutateAsync({ id: c.id })}>Alerts will stop going there.</Confirm>
                </div>
              );
            })}
            {!rows.length && <div className="home-part-b t3">Nowhere yet. Alerts only show in the Inbox until you add a channel.</div>}
          </Part>
        </>
      )}
    </Load>
  );
}

const ROLES = ["viewer", "operator", "admin", "owner"] as const;

function Members() {
  const q = useFn(settingsMembersFn, undefined);
  const change = useAct(changeRoleFn);
  const invite = useAct(inviteMemberFn);
  const cancel = useAct(cancelInviteFn);
  const drop = useAct(dropMemberFn);
  const [link, setLink] = useState("");
  const form = useForm({
    defaultValues: { email: "", role: "operator" as (typeof ROLES)[number] },
    onSubmit: ({ value, formApi }) => invite.mutate(value, { onSuccess: (made) => { setLink(made.url); formApi.reset(); }, onError: (error) => toast(errorText(error)) }),
  });
  const roleOptions = ROLES.map((role) => [role, role.charAt(0).toUpperCase() + role.slice(1)] as [typeof role, string]);
  return (
    <Load q={q}>
      {(d) => (
        <>
          <Part title="People who can sign in">
            {d.mode === "local" && <div className="home-part-b t3">Local mode has no sign-in: only this machine can reach it. On a server, everyone signs in here.</div>}
            {d.members.map((m) => (
              <div className="lst home-lst" key={m.id}>
                <Avatar name={m.name || m.email} size={22} />
                <span className="home-lst-main"><b className="ell">{m.name || m.email}</b><small className="t3 ell">{m.email}</small></span>
                <span className="grow" />
                <Choice label={`Role of ${m.name}`} value={m.role} onChange={(role) => change.mutate({ id: m.id, role }, { onSuccess: () => toast("Role changed"), onError: (error) => toast(errorText(error)) })} options={roleOptions} />
                <Confirm trigger={<button className="btn">Remove</button>} title={`Remove ${m.name || m.email}?`} action="Remove" danger onConfirm={async () => { await drop.mutateAsync({ id: m.id }); toast("Removed"); }}>They are signed out at once and can no longer sign in.</Confirm>
              </div>
            ))}
            <p className="home-line t3">A viewer reads. An operator also edits dashboards and alerts. An admin also manages channels and tokens. An owner also manages members.</p>
          </Part>
          {d.mode !== "local" && (
            <Part title="Invite someone">
              <form className="home-invite" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
                <div className="grow"><form.Field name="email">{(field) => <TextField field={field} label="Email" type="email" />}</form.Field></div>
                <form.Field name="role">{(field) => <label className="field">Role<span><Choice label="Role" value={field.state.value} onChange={(role) => field.handleChange(role)} options={roleOptions} /></span></label>}</form.Field>
                <button className="btn pri" type="submit" disabled={invite.isPending}>Create link</button>
              </form>
              {link && <div className="stmt home-secret">Send this link yourself. It works once, for 7 days, and is shown only now.<br /><b style={{ wordBreak: "break-all" }}>{link}</b> <button style={{ marginLeft: 6 }} onClick={() => copy(link, "Link copied")}>Copy</button></div>}
              {d.invites.map((pending) => (
                <div className="lst home-lst" key={pending.id}>
                  <span className="home-lst-main"><b className="ell">{pending.email}</b><small className="t3">{pending.role}, until {dayMonth(pending.expires)}</small></span>
                  <span className="grow" />
                  <button className="btn" onClick={() => cancel.mutate({ id: pending.id })}>Cancel</button>
                </div>
              ))}
            </Part>
          )}
          {d.mode !== "local" && <Security />}
        </>
      )}
    </Load>
  );
}

async function authPost<T>(path: string, body: unknown) {
  const response = await fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? "That did not work.");
  return data;
}

/** Your own password and second factor. Vigie has its own login, so these live here. */
function Security() {
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [on, setOn] = useState(false);
  const run = (work: () => Promise<void>) => work().catch((error) => toast(errorText(error)));
  const svg = useMemo(() => (setup ? renderSVG(setup.uri, { border: 2, whiteColor: "#ECECEA", blackColor: "#18181B" }) : ""), [setup]);
  return (
    <Part title="Your sign-in">
      <div className="home-part-b" style={{ display: "grid", gap: 10, maxWidth: 460 }}>
        <input className="input" type="password" aria-label="Current password" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="row">
          <input className="input grow" type="password" aria-label="New password" placeholder="New password, 10 characters or more" value={next} onChange={(e) => setNext(e.target.value)} />
          <button className="btn" disabled={next.length < 10 || !password} onClick={() => run(async () => { await authPost("/change-password", { currentPassword: password, newPassword: next, revokeOtherSessions: true }); setNext(""); toast("Password changed. Other sessions are signed out."); })}>Change password</button>
        </div>
        {!setup && !on && <div><button className="btn" disabled={!password} onClick={() => run(async () => { const made = await authPost<{ totpURI: string; backupCodes: string[] }>("/two-factor/enable", { password }); setSetup({ uri: made.totpURI, backupCodes: made.backupCodes }); })}>Turn on two-factor sign-in</button></div>}
        {setup && !on && (
          <>
            <p className="t2" style={{ margin: 0 }}>Scan this with your authenticator app, then enter its code.</p>
            <div aria-label="Two-factor QR code" style={{ width: 170, borderRadius: 8, overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="row">
              <input className="input" style={{ width: 130 }} aria-label="Code from your app" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn pri" disabled={code.trim().length < 6} onClick={() => run(async () => { await authPost("/two-factor/verify-totp", { code: code.trim() }); setOn(true); toast("Two-factor sign-in is on"); })}>Confirm</button>
            </div>
          </>
        )}
        {setup && on && (
          <div className="stmt">Keep these backup codes somewhere safe. Each works once if you lose your phone, and they are shown only now.<br /><b style={{ wordBreak: "break-word" }}>{setup.backupCodes.join("  ")}</b></div>
        )}
      </div>
    </Part>
  );
}

const KIND_LABEL = { ingest: "Ingest", api: "API", mcp: "MCP", deploy: "Deploy markers" } as const;

/** What can reach Vigie without a person, and whether it still does. */
function Tokens() {
  const q = useFn(settingsTokensFn, undefined);
  const add = useAct(addTokenFn);
  const drop = useAct(dropTokenFn);
  const [secret, setSecret] = useState("");
  const form = useForm({
    defaultValues: { kind: "mcp" as "ingest" | "api" | "mcp" | "deploy", name: "", scope: "read" as "read" | "write" },
    onSubmit: ({ value, formApi }) => add.mutate(value, { onSuccess: (token) => { setSecret(token.secret); formApi.reset(); }, onError: (error) => toast(errorText(error)) }),
  });
  return (
    <Load q={q}>
      {(rows) => {
        const live = rows.filter((t) => !t.revoked_at).sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0));
        return (
          <Part title="Tokens in use" right={
            <Pop align="end" width={300} trigger={<button className="btn pri"><Icon name="plus" />New token</button>}>
              <form className="home-pop-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
                <form.Field name="name" validators={{ onChange: ({ value }) => (value.trim() ? undefined : "Say what uses it") }}>{(field) => <TextField field={field} label="Name" placeholder="Claude Code on this Mac" autoFocus />}</form.Field>
                <form.Field name="kind">{(field) => <label className="field">Kind<span><Choice label="Kind" value={field.state.value} onChange={field.handleChange} options={[["mcp", "MCP"], ["api", "API"], ["ingest", "Ingest"], ["deploy", "Deploy markers"]]} /></span></label>}</form.Field>
                <form.Field name="scope">{(field) => <label className="field">Scope<span><Choice label="Scope" value={field.state.value} onChange={field.handleChange} options={[["read", "Read only"], ["write", "Read and write"]]} /></span></label>}</form.Field>
                <button className="btn pri" type="submit">Create token</button>
              </form>
            </Pop>
          }>
            {secret && <div className="stmt home-secret">Copy this now. It is shown once and stored hashed.<br /><button className="lnk mono" onClick={() => copy(secret)}>{secret}</button></div>}
            {live.map((t) => (
              <div className="lst home-lst" key={t.id}>
                <span className="home-lst-main"><b className="ell">{t.name}</b><small className="t3">{KIND_LABEL[t.kind]}, {t.scope === "write" ? "read and write" : "read only"}</small></span>
                <span className="mono t3 grow ell home-lst-hide">{t.prefix}</span>
                <span className={t.last_used ? "t3" : "t4"} style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t.last_used ? `Used ${ago(t.last_used)}` : "Never used"}</span>
                <Confirm trigger={<button className="btn">Revoke</button>} title={`Revoke ${t.name}?`} action="Revoke" danger onConfirm={() => drop.mutateAsync({ id: t.id })}>Whatever uses it stops working at once.</Confirm>
              </div>
            ))}
            {!live.length && <div className="home-part-b t3">None yet. An agent over MCP, a script over the API and a deploy marker each need one.</div>}
          </Part>
        );
      }}
    </Load>
  );
}

/** What your code added to Vigie, and what failed to load. */
function Extensions() {
  const q = useFn(settingsExtensionsFn, undefined);
  const reload = useAct(reloadExtensionsFn);
  return (
    <Load q={q}>
      {(d) => {
        const failed = d.loaded.filter((e) => !e.ok);
        const rows = [...failed, ...d.loaded.filter((e) => e.ok)];
        return (
          <Part title={<>Loaded from <span className="mono">{d.dir.split("/").slice(-2).join("/")}</span></>} right={<button className="btn" disabled={reload.isPending} onClick={() => reload.mutate(undefined, { onSuccess: (r) => toast(`Reloaded in ${r.reloadMs} ms`), onError: (error) => toast(errorText(error)) })}>Reload</button>}>
            {rows.map((e) => (
              <div className={`home-ext ${e.ok ? "" : "bad"}`} key={e.file}>
                <div className="lst home-lst">
                  <span className="mono grow ell">{e.file}</span>
                  <span className="t3 home-lst-hide">{e.label}</span>
                  {e.ok ? <Chip tone="ok">Loaded</Chip> : <Chip tone="err">Failed</Chip>}
                </div>
                {!e.ok && e.error && <Sql text={e.error} lang="log" />}
              </div>
            ))}
            <p className="home-line t3">{d.hotReload ? `Saved files reload here at once. The last reload took ${d.reloadMs} ms.` : `Definitions load at start. The last load took ${d.reloadMs} ms.`}</p>
          </Part>
        );
      }}
    </Load>
  );
}

/** What never reaches storage, and proof on any value you give it. */
function Redaction() {
  const q = useFn(settingsRedactionFn, undefined);
  const test = useAct(tryRedactionFn);
  const [key, setKey] = useState("email");
  const [value, setValue] = useState("camille@example.com");
  useEffect(() => {
    const timer = setTimeout(() => test.mutate({ key, value }), 220);
    return () => clearTimeout(timer);
    // The mutation object changes on every call, the inputs are what should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);
  return (
    <Load q={q}>
      {(d) => (
        <>
          <Part title="Try it">
            <div className="home-try">
              <label className="field">Field name<input className="input" aria-label="Field name" value={key} onChange={(event) => setKey(event.target.value)} /></label>
              <label className="field">Value<input className="input" aria-label="Value" value={value} onChange={(event) => setValue(event.target.value)} /></label>
              <div className="field home-try-out">Stored as{test.data ? <Sql text={test.data.value} lang="log" /> : <span className="home-try-wait" />}</div>
            </div>
          </Part>
          <Part title="Rules in force" right={<span className="t3 home-part-note">Masked since this start</span>}>
            {d.rules.map((r) => (
              <div className="lst home-lst" key={r.id}>
                <span className="home-lst-main"><b>{r.title}</b></span>
                <span className="mono t3 grow ell home-lst-hide" title={r.detail}>{r.detail}</span>
                <span className={`mono ${r.count ? "" : "t4"}`}>{num(r.count)}</span>
              </div>
            ))}
          </Part>
        </>
      )}
    </Load>
  );
}

/** Who changed what, and through which door. */
function Audit() {
  const q = useFn(settingsAuditFn, undefined);
  const { q: text = "" } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <Load q={q}>
      {(rows) => {
        const low = text.toLowerCase();
        const shown = rows.filter((a) => `${a.actor} ${a.action} ${a.target ?? ""} ${a.through}`.toLowerCase().includes(low));
        let day = "";
        return (
          <>
            <div className="subbar home-bar">
              <SearchBox id="home-audit-q" value={text} onChange={(value) => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, q: value || undefined })) as never, replace: true })} placeholder="Search by who or what" />
            </div>
            {shown.map((a) => {
              const today = dayMonth(a.at);
              const head = today !== day;
              day = today;
              return (
                <Fragment key={a.id}>
                  {head && <div className="home-day">{today}</div>}
                  <div className="home-audit">
                    <span className="home-audit-t">{hm(a.at)}</span>
                    <b className="ell">{a.actor}</b>
                    <span className="ell t2" title={`${a.action}${a.target ? `: ${a.target}` : ""}`}>{a.action}{a.target && <span className="t3">: {a.target}</span>}</span>
                    <span className={a.through === "mcp" ? "home-through mcp" : "home-through"}>{a.through.toUpperCase()}</span>
                  </div>
                </Fragment>
              );
            })}
            {!shown.length && <div className="home-quiet"><b>{rows.length ? "Nothing matches this" : "Nothing recorded yet"}</b>{!rows.length && <span>Every change to channels, tokens, members, dashboards and alerts lands here.</span>}</div>}
          </>
        );
      }}
    </Load>
  );
}

const BODY = { services: Services, storage: Storage, channels: Channels, members: Members, tokens: Tokens, extensions: Extensions, redaction: Redaction, audit: Audit } as const;

function SettingsPage() {
  const { section } = Route.useParams();
  const Body = BODY[section as keyof typeof BODY];
  return (
    <div className="setw home-setw">
      <div className="sets">
        {SECTIONS.map(([group, items]) => (
          <Fragment key={group}>
            <div className="home-sets-g">{group}</div>
            {items.map(([id, label]) => (
              <Link key={id} className={`mitem ${id === section ? "on" : ""}`} to="/settings/$section" params={{ section: id }}><span>{label}</span></Link>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="setb home-setb">{Body ? <Body /> : <Empty title="No such section" />}</div>
    </div>
  );
}
