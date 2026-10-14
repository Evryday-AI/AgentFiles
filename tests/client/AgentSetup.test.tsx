// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import * as api from "../../src/client/api";
import { click, input, render, submit } from "./dom";
import { act } from "react";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function setup() {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let createdKeyCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body =
        url === "/api/instance"
          ? {
              name: "AgentFiles",
              base_url: "https://files.example.test",
              retention_days: 7,
              max_upload_bytes: 1024,
              allow_persistent_files: false,
              skill_url:
                "https://files.example.test/skills/agentfiles/SKILL.md",
            }
          : url === "/api/auth/session"
            ? init.credentials === "omit"
              ? { authenticated: false, principal: null }
              : {
                  authenticated: true,
                  principal: { type: "admin", name: "fixture admin" },
                }
            : url === "/api/admin/api-keys"
              ? init.method === "POST"
                ? {
                    secret: "synthetic-one-time-value",
                    apiKey: { id: `fixture-${++createdKeyCount}`, name: "fixture agent" },
                  }
                : { apiKeys: [] }
              : url.startsWith("/api/files?")
                ? { files: [] }
                : {
                    bytes: 64,
                    managed_bytes: 64,
                    reserved_bytes: 16,
                    max_storage_bytes: 1024,
                    cleanup: {
                      pending_expired_bytes: 8,
                      failed_files: 1,
                      last_success_at: null,
                    },
                  };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
it("checks only the bearer key, never the current admin cookie", async () => {
  setup();
  expect(typeof api.checkAgentConnection).toBe("function");
  await api.checkAgentConnection("synthetic-bad-value");
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/auth/session",
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      headers: { authorization: "Bearer synthetic-bad-value" },
    }),
  );
});
it("creates a minimal named key and clears its displayed secret on dismiss and logout", async () => {
  const errors = vi.spyOn(console, "error");
  const calls = setup();
  const view = await render(<App />);
  await click(view.host, "settings");
  expect(view.host.textContent).toContain("https://files.example.test");
  await input(view.host, "Key name", "fixture agent");
  await submit(view.host);
  expect(view.host.textContent).toContain("synthetic-one-time-value");
  const payload = JSON.parse(
    String(
      calls.find(
        (c) => c.init.method === "POST" && c.url === "/api/admin/api-keys",
      )?.init.body,
    ),
  );
  expect(payload).toEqual({
    name: "fixture agent",
    can_upload: true,
    can_download: true,
    can_list: false,
    can_delete: false,
    can_share: false,
    can_mark_durable: false,
  });
  await click(view.host, "Check connection");
  expect(view.host.textContent).toContain("Connection failed");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(location.href).not.toContain("synthetic-one-time-value");
  await click(view.host, "Dismiss secret");
  expect(view.host.textContent).not.toContain("synthetic-one-time-value");
  await input(view.host, "Key name", "fixture agent");
  await submit(view.host);
  await click(view.host, "Sign out");
  expect(view.host.textContent).not.toContain("synthetic-one-time-value");
  await view.unmount();
  expect(errors.mock.calls.filter(args => args.some(value => String(value).includes("same key")))).toEqual([]);
});
it("renders authenticated capacity and delayed cleanup state", async () => {
  setup();
  const view = await render(<App />);
  await click(view.host, "settings");
  expect(view.host.textContent).toContain("Reserved");
  expect(view.host.textContent).toContain("Pending expiry");
  expect(view.host.textContent).toContain("Cleanup delayed");
  await view.unmount();
});
it("does not show an old successful check after the key input changes", async () => {
  setup();
  const v = await render(<App />);
  await click(v.host, "settings");
  await input(v.host, "Check an existing key", "first-synthetic");
  let complete!: (value: Response) => void;
  const previous = fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    init.credentials === "omit"
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : previous(url, init),
  );
  await click(v.host, "Check connection");
  await input(v.host, "Check an existing key", "different-synthetic");
  await act(async () =>
    complete(
      new Response(
        JSON.stringify({
          authenticated: true,
          principal: {
            type: "api_key",
            name: "old success",
            canUpload: true,
            canDownload: true,
            canList: false,
            canDelete: false,
            canShare: false,
            canMarkDurable: false,
          },
        }),
      ),
    ),
  );
  expect(v.host.textContent).not.toContain("Connected as old success");
  await v.unmount();
});
it("shows the actual permission flags from a successful check", async () => {
  setup();
  const v = await render(<App />);
  await click(v.host, "settings");
  await input(v.host, "Check an existing key", "valid-synthetic");
  const previous = fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    init.credentials === "omit"
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              authenticated: true,
              principal: {
                type: "api_key",
                name: "scoped",
                canUpload: true,
                canDownload: false,
                canList: false,
                canDelete: false,
                canShare: false,
                canMarkDurable: false,
              },
            }),
          ),
        )
      : previous(url, init),
  );
  await click(v.host, "Check connection");
  expect(v.host.textContent).toContain("canDownload: false");
  expect(v.host.textContent).toContain("canUpload: true");
  await v.unmount();
});
it("copies the one-time value and clears it on revoke or leaving settings", async () => {
  setup();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const v = await render(<App />);
  await click(v.host, "settings");
  await input(v.host, "Key name", "fixture agent");
  await submit(v.host);
  await click(v.host, "Copy secret");
  expect(writeText).toHaveBeenCalledWith("synthetic-one-time-value");
  await click(v.host, "Revoke");
  expect(v.host.textContent).not.toContain("synthetic-one-time-value");
  await input(v.host, "Key name", "fixture agent");
  await submit(v.host);
  await click(v.host, "gallery");
  await click(v.host, "settings");
  expect(v.host.textContent).not.toContain("synthetic-one-time-value");
  await v.unmount();
});
it("does not restore a key created after settings unmount", async () => {
  setup();
  const previous = fetch;
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url === "/api/admin/api-keys" && init.method === "POST"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : previous(url, init),
  );
  const v = await render(<App />);
  await click(v.host, "settings");
  await input(v.host, "Key name", "pending fixture");
  await submit(v.host);
  await click(v.host, "gallery");
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          apiKey: { id: "pending", name: "pending fixture" },
          secret: "synthetic-late-secret",
        }),
      ),
    ),
  );
  await click(v.host, "settings");
  expect(v.host.textContent).not.toContain("synthetic-late-secret");
  await v.unmount();
});
it("reports settled unavailable storage instead of checking forever", async () => {
  setup();
  const previous = fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url === "/api/admin/storage-usage"
      ? Promise.resolve(new Response("{}", { status: 404 }))
      : previous(url, init),
  );
  const view = await render(<App />);
  await click(view.host, "settings");
  expect(view.host.textContent).toContain("Storage status unavailable");
  expect(view.host.textContent).not.toContain("Checking storage");
  await view.unmount();
});

it("retains a pending key-list response after the connection input changes", async () => {
  setup();
  const previous = fetch;
  let finishList!: (value: Response) => void;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url === "/api/admin/api-keys" && init.method !== "POST"
      ? new Promise<Response>((resolve) => {
          finishList = resolve;
        })
      : previous(url, init),
  );
  const view = await render(<App />);
  await click(view.host, "settings");
  await input(view.host, "Check an existing key", "edited-synthetic-key");
  await act(async () =>
    finishList(
      new Response(
        JSON.stringify({
          apiKeys: [
            {
              id: "existing",
              name: "existing synthetic agent",
              canUpload: true,
              canDownload: true,
            },
          ],
        }),
      ),
    ),
  );
  try {
    expect(view.host.querySelector(".api-key-list")?.textContent).toContain(
      "existing synthetic agent",
    );
    expect(view.host.querySelector(".api-key-row button")?.textContent).toBe(
      "Revoke",
    );
  } finally {
    await view.unmount();
  }
});
it("keeps key creation pending and exposes its one-time result after connection input changes", async () => {
  setup();
  const previous = fetch;
  let finishCreate!: (value: Response) => void;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url === "/api/admin/api-keys" && init.method === "POST"
      ? new Promise<Response>((resolve) => {
          finishCreate = resolve;
        })
      : previous(url, init),
  );
  const view = await render(<App />);
  await click(view.host, "settings");
  await input(view.host, "Key name", "pending synthetic agent");
  await submit(view.host);
  await input(view.host, "Check an existing key", "edited-synthetic-key");
  try {
    expect(
      view.host.querySelector<HTMLButtonElement>(
        '.key-form button[type="submit"]',
      )?.disabled,
    ).toBe(true);
    await act(async () =>
      finishCreate(
        new Response(
          JSON.stringify({
            apiKey: { id: "created", name: "pending synthetic agent" },
            secret: "synthetic-created-once",
          }),
        ),
      ),
    );
    expect(view.host.querySelector(".secret-box")?.textContent).toContain(
      "synthetic-created-once",
    );
    expect(view.host.querySelector(".api-key-list")?.textContent).toContain(
      "pending synthetic agent",
    );
    await click(view.host, "Dismiss secret");
    expect(view.host.textContent).not.toContain("synthetic-created-once");
  } finally {
    await act(async () =>
      finishCreate(
        new Response(
          JSON.stringify({
            apiKey: { id: "created" },
            secret: "synthetic-created-once",
          }),
        ),
      ),
    );
    await view.unmount();
  }
});
it.each(["Dismiss secret", "Revoke"])(
  "does not restore pending connection success after %s",
  async (action) => {
    setup();
    const view = await render(<App />);
    await click(view.host, "settings");
    await input(view.host, "Key name", "lifecycle fixture");
    await submit(view.host);
    const previous = fetch;
    let finishCheck!: (value: Response) => void;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      init.credentials === "omit"
        ? new Promise<Response>((resolve) => {
            finishCheck = resolve;
          })
        : previous(url, init),
    );
    await click(view.host, "Check connection");
    // Revoke is disabled during a check: dismiss first cancels that check,
    // allowing revocation while its HTTP completion remains outstanding.
    if (action === "Revoke") await click(view.host, "Dismiss secret");
    await click(view.host, action);
    await act(async () =>
      finishCheck(
        new Response(
          JSON.stringify({
            authenticated: true,
            principal: { type: "api_key", name: "late synthetic connection" },
          }),
        ),
      ),
    );
    expect(view.host.textContent).not.toContain("synthetic-one-time-value");
    expect(view.host.textContent).not.toContain(
      "Connected as late synthetic connection",
    );
    await view.unmount();
  },
);
