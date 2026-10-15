import { BlockList, isIP } from "node:net";

export type DeploymentMode = "local" | "public";
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** Validate before URL normalization can hide paths, delimiters or userinfo. */
export function parsePublicOrigin(value: string, deploymentMode: DeploymentMode): string {
  const fail = (): never => { throw new Error("PUBLIC_BASE_URL must be an origin allowed by DEPLOYMENT_MODE"); };
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/.test(value) || value.includes("@")) fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const isLoopback = hostname.toLowerCase().replace(/\.$/, "") === "localhost" ||
    (family !== 0 && loopback.check(hostname, family === 4 ? "ipv4" : "ipv6"));
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail();
  if (deploymentMode === "local") {
    if (url.protocol !== "http:" || !isLoopback) fail();
  } else if (deploymentMode === "public") {
    if (url.protocol !== "https:" || isLoopback) fail();
  } else { fail(); }
  return url.origin;
}
