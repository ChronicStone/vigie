import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { TextField } from "@web/components/form.tsx";
import { Mark } from "@web/components/icons.tsx";

const search = z.object({ next: z.string().optional().catch(undefined), invite: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/login")({ validateSearch: search, component: LoginPage });

type Session = { actor: unknown; mode: string; needsSetup: boolean; oidc: boolean; allowSignup: boolean; oidcName?: string };

async function authCall(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { message?: string; url?: string; twoFactorRedirect?: boolean };
  if (!response.ok) throw new Error(data.message ?? "Sign-in failed.");
  return data;
}

function LoginPage() {
  const { next, invite } = Route.useSearch();
  const session = useQuery({ queryKey: ["session"], queryFn: async () => (await (await fetch("/api/session")).json()) as Session });
  const [error, setError] = useState("");
  const setup = session.data?.needsSetup ?? false;
  const invited = useQuery({ queryKey: ["invite", invite], enabled: Boolean(invite), retry: false, queryFn: async () => {
    const response = await fetch(`/api/invite?token=${encodeURIComponent(invite ?? "")}`);
    if (!response.ok) throw new Error("This invitation has expired or was already used. Ask for a new one.");
    return (await response.json()) as { email: string };
  } });
  const [needsCode, setNeedsCode] = useState(false);
  const joining = Boolean(invite && invited.data);
  const go = () => location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  const form = useForm({
    defaultValues: { name: "", email: "", password: "", code: "", totp: "" },
    onSubmit: async ({ value }) => {
      setError("");
      try {
        if (needsCode) {
          await authCall("/two-factor/verify-totp", { code: value.totp.trim(), trustDevice: false });
        } else if (invite && invited.data) {
          await authCall("/sign-up/email", { name: value.name, email: invited.data.email, password: value.password }, { "x-vigie-invite": invite });
        } else if (setup) {
          await authCall("/sign-up/email", { name: value.name, email: value.email, password: value.password }, { "x-vigie-setup-code": value.code });
        } else {
          const result = await authCall("/sign-in/email", { email: value.email, password: value.password, rememberMe: true });
          if (result.twoFactorRedirect) {
            setNeedsCode(true);
            return;
          }
        }
        go();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
  });
  // A field that has rendered keeps its validator, so wait until we know which fields this page needs.
  if (session.isPending || (invite && invited.isPending)) return <div className="loginw home-login" />;
  if (session.data?.mode === "local" && !invite) {
    return (
      <div className="loginw home-login">
        <div className="home-login-brand"><Mark /> Vigie</div>
        <div className="loginc home-login-c">
          <h2>No sign-in here</h2>
          <p className="t3">Local mode only answers this machine, so there is nothing to sign in to.</p>
          <a className="btn pri home-login-do" href="/">Open Vigie</a>
        </div>
      </div>
    );
  }
  return (
    <div className="loginw home-login">
      <div className="home-login-brand"><Mark /> Vigie</div>
      <form className="loginc home-login-c" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <h2>{needsCode ? "Enter your code" : joining ? "Join Vigie" : setup ? "Create the owner" : "Sign in"}</h2>
        {invite && invited.error && <div className="err" role="alert" style={{ fontSize: 12.5 }}>{invited.error.message}</div>}
        {joining && !needsCode && <p className="t3">You were invited as {invited.data!.email}.</p>}
        {needsCode && <p className="t3">From your authenticator app.</p>}
        {needsCode && <form.Field name="totp">{(field) => <TextField field={field} label="6-digit code" autoFocus />}</form.Field>}
        {setup && <p className="t3">The setup code is printed in the server's logs.</p>}
        {setup && <form.Field name="code" validators={{ onChange: ({ value }) => (value.trim() ? undefined : "The code from the logs") }}>{(field) => <TextField field={field} label="Setup code" autoFocus />}</form.Field>}
        {(setup || joining) && !needsCode && <form.Field name="name">{(field) => <TextField field={field} label="Your name" />}</form.Field>}
        {!joining && !needsCode && <form.Field name="email" validators={{ onChange: ({ value }) => (/.+@.+/.test(value) ? undefined : "An email address") }}>{(field) => <TextField field={field} label="Email" type="email" autoFocus={!setup} />}</form.Field>}
        {!needsCode && <form.Field name="password" validators={{ onChange: ({ value }) => (value.length >= 10 ? undefined : "At least 10 characters") }}>{(field) => <TextField field={field} label="Password" type="password" />}</form.Field>}
        {error && <div className="err" role="alert" style={{ fontSize: 12.5 }}>{error}</div>}
        <form.Subscribe selector={(state) => state.isSubmitting}>{(busy) => <button className="btn pri home-login-do" disabled={busy} type="submit">{needsCode ? "Confirm" : joining ? "Create my account" : setup ? "Create and continue" : "Sign in"}</button>}</form.Subscribe>
        {session.data?.oidc && !setup && !needsCode && !invite && (
          <button type="button" className="btn home-login-do" onClick={async () => {
            try {
              const data = await authCall("/sign-in/social", { provider: "app", callbackURL: next ?? "/" });
              if (data.url) location.assign(data.url);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          }}>Continue with {session.data?.oidcName ?? "single sign-on"}</button>
        )}
      </form>
    </div>
  );
}
