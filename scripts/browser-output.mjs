import { sanitizeDiagnostics } from "./smoke-compose.mjs";
export function sanitizeBrowserOutput(value, secrets = []) {
  return sanitizeDiagnostics(value, secrets)
    .replace(/af_[a-f0-9]{24}_[a-f0-9]{64}/gi, "[key redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(?:cookie|set-cookie|authorization)\s*:\s*[^\r\n]+/gi,
      "[header redacted]",
    );
}
