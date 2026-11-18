import { createFileRoute } from "@tanstack/react-router";
import { Shell } from "@web/components/shell.tsx";
import { queryClient } from "@web/lib/api.ts";
import { setEnvironments } from "@web/lib/scope.ts";
import { setAppName } from "@web/lib/app-name.ts";

const session = () => fetch("/api/session").then((response) => response.json() as Promise<{ environments?: string[]; appName?: string }>);

export const Route = createFileRoute("/_app")({
  /** Every query is scoped to an environment, so the list must be known before the first one runs. */
  beforeLoad: async () => {
    const found = await queryClient.ensureQueryData({ queryKey: ["session-environments"], queryFn: session, staleTime: Infinity }).catch(() => null);
    setEnvironments(found?.environments ?? []);
    setAppName(found?.appName);
  },
  component: Shell,
});
