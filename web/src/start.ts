import { createStart } from "@tanstack/react-start";

/** A pure SPA: the server sends one static shell, every screen renders in the browser. */
export const startInstance = createStart(() => ({ defaultSsr: false }));
