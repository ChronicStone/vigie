import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, retainSearchParams, Scripts } from "@tanstack/react-router";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import "@web/styles/design.css";
import "@web/styles/app.css";
import "@web/styles/motion.css";
import "@web/styles/sections.css";
import "@web/styles/pages/explore.css";
import "@web/styles/pages/backend.css";
import "@web/styles/pages/tasks.css";
import "@web/styles/pages/reliability.css";
import "@web/styles/pages/home.css";
import { Toaster } from "@web/components/toast.tsx";
import { queryClient } from "@web/lib/api.ts";
import { rootSearch } from "@web/lib/scope.ts";

export const Route = createRootRoute({
  validateSearch: rootSearch,
  search: { middlewares: [retainSearchParams(["env", "range", "from", "to", "svc", "live"])] },
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { name: "theme-color", content: "#18181B" }, { title: "Vigie" }],
    links: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
  }),
  shellComponent: Document,
  component: Root,
  notFoundComponent: () => (
    <div className="ph" style={{ padding: 60 }}>
      <div>
        <h3>No such page</h3>
        <p>Press ⌘K to jump to one that exists.</p>
      </div>
    </div>
  ),
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delay={350}>
        <Toaster>
          <Outlet />
        </Toaster>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
