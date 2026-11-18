import { createRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/** A screen that throws stays a screen that failed: the shell and the navigation keep working. */
function ScreenFailed({ error, reset }: ErrorComponentProps) {
  return (
    <div className="ph" style={{ padding: "60px 20px" }} role="alert">
      <div>
        <h3>This screen failed</h3>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <button className="btn" style={{ marginTop: 12 }} onClick={reset}>Try again</button>
      </div>
    </div>
  );
}

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent", defaultPreloadDelay: 80, defaultErrorComponent: ScreenFailed });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
