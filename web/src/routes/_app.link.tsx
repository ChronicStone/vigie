import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Choice } from "@web/components/form.tsx";
import { Part } from "@web/components/reliability.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { decideLinkFn, pendingLinkFn } from "@web/fns/admin.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";
import { ago } from "@web/lib/format.ts";
import { ENV_LABEL } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/link")({ validateSearch: z.object({ code: z.string().catch("") }), component: LinkPage });

/** The page `node ace add @vigie/adonis` opens: allow one app to send telemetry, without copying a key. */
function LinkPage() {
  const { code } = Route.useSearch();
  const q = useFn(pendingLinkFn, { code }, { refetchInterval: false });
  const decide = useAct(decideLinkFn);
  const [environment, setEnvironment] = useState("");
  const [done, setDone] = useState<{ service: string; allowed: boolean } | null>(null);
  return (
    <>
      <div className="ov link-page">
        {done ? (
          <Part title={done.allowed ? `${done.service} is linked` : `${done.service} was refused`}>
            <p className="home-part-b">{done.allowed ? "The installer in your terminal has its key now and finishes on its own. You can close this tab." : "The installer stops and nothing was created."}</p>
            {done.allowed && <p className="home-part-b"><Link className="tlink" to="/logs">Open the logs</Link></p>}
          </Part>
        ) : (
          <Load q={q}>
            {({ request, environments }) => {
              if (!request) return <Empty title="This code has expired or was already used" hint="Codes last 10 minutes. Run the installer again in your app." />;
              const env = environment || environments[0] || "";
              return (
                <Part title={`Let ${request.service} send telemetry here?`}>
                  <div className="home-part-b link-body">
                    <p>Check that your terminal shows the same code: <b className="mono link-code">{request.code}</b></p>
                    <p className="t3">Asked {ago(request.created)}. Allowing it creates an ingest key named {request.service}, which you can revoke in Settings, Tokens.</p>
                    {environments.length > 1 && (
                      <label className="field">Its data counts as<span><Choice label="Environment" value={env} onChange={setEnvironment} options={environments.map((e) => [e, ENV_LABEL[e as keyof typeof ENV_LABEL] ?? e] as const)} /></span></label>
                    )}
                    {decide.error && <p className="err" role="alert">{errorText(decide.error)}</p>}
                    <div className="link-actions">
                      <button className="btn pri" disabled={decide.isPending} onClick={() => decide.mutate({ code: request.code, allow: true, environment: env || undefined }, { onSuccess: setDone })}>Allow {request.service}</button>
                      <button className="btn" disabled={decide.isPending} onClick={() => decide.mutate({ code: request.code, allow: false }, { onSuccess: setDone })}>Refuse</button>
                    </div>
                  </div>
                </Part>
              );
            }}
          </Load>
        )}
      </div>
    </>
  );
}
