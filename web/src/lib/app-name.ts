/** The observed app's name, from VIGIE_APP_NAME. Set once by the shell before the first screen renders. */
export let appName = "your app";
/** Service names often start with the app's slug ("acme-api"): screens show the rest. */
let prefix: RegExp | null = null;

export function setAppName(name: string | undefined) {
  if (!name) return;
  appName = name;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  prefix = slug ? new RegExp(`^${slug}-`) : null;
}

export const stripAppPrefix = (service: string) => (prefix ? service.replace(prefix, "") : service);
