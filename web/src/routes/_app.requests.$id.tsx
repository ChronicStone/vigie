import { createFileRoute, redirect } from "@tanstack/react-router";

/** A request is a trace. Old links keep working, with whatever scope they carried. */
export const Route = createFileRoute("/_app/requests/$id")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/traces/$id", params: { id: params.id }, search: search as never, replace: true });
  },
});
