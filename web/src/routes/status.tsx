import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { StatusView } from "@web/components/status-view.tsx";
import { statusPageFn } from "@web/fns/reliability.ts";

export const Route = createFileRoute("/status")({ component: StatusPage });

function StatusPage() {
  const q = useQuery({ queryKey: ["status-page"], queryFn: () => statusPageFn(), refetchInterval: 60_000, retry: false });
  if (q.isError) return <main className="status-private"><div><h1>This status page is private</h1><p>Sign in to see it, or ask an administrator to make it public.</p></div></main>;
  if (!q.data) return <main className="sp" aria-busy="true" />;
  return <StatusView model={q.data} updatedAt={q.dataUpdatedAt} />;
}
