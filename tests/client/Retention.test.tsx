// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { type FileItem, type Principal } from "../../src/client/api";
import { click, render } from "./dom";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  document.body.replaceChildren();
});
const admin: Principal = { type: "admin", name: "synthetic admin" };
const key: Principal = {
  type: "api_key",
  id: "synthetic-key",
  name: "synthetic agent",
  canUpload: true,
  canDownload: true,
  canList: true,
  canDelete: false,
  canShare: false,
  canMarkDurable: true,
};
function setup(
  principal: Principal,
  allowPersistent: boolean,
  durable: boolean,
) {
  let file: FileItem = {
    code: "F-DEF45",
    name: "retention-fixture.txt",
    mime_type: "text/plain",
    size: 8,
    size_bytes: 8,
    created_at: "2026-10-11T00:00:00Z",
    updated_at: "2026-10-11T00:00:00Z",
    expiry: durable ? null : "2030-01-01T00:00:00Z",
    expires_at: durable ? null : "2030-01-01T00:00:00Z",
    durable,
    is_durable: durable,
    sha256: "b".repeat(64),
    private_url: "https://files.example.test/files/F-DEF45",
    api_download_url: "https://files.example.test/api/files/F-DEF45/download",
    uploaded_by: { type: "admin", name: "synthetic uploader" },
    metadata: {},
  };
  const mutations: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      mutations.push({ url, body });
      file = {
        ...file,
        durable: body.durable,
        is_durable: body.durable,
        expiry: body.durable ? null : "2030-01-01T00:00:00Z",
        expires_at: body.durable ? null : "2030-01-01T00:00:00Z",
      };
    }
    return new Response(
      JSON.stringify(
        url === "/api/auth/session"
          ? { authenticated: true, principal }
          : url === "/api/instance"
            ? { allow_persistent_files: allowPersistent }
            : url.startsWith("/api/files?")
              ? { files: [file] }
              : file,
      ),
    );
  });
  history.replaceState(null, "", `/files/${file.code}`);
  return mutations;
}
it.each([admin, key])(
  "allows $type to remove existing persistence when new persistence is disabled",
  async (principal) => {
    const mutations = setup(principal, false, true);
    const view = await render(<App />);
    try {
      const button = [...view.host.querySelectorAll("button")].find(
        (el) => el.textContent === "Use auto-expiry",
      )!;
      expect(button.disabled).toBe(false);
      await click(view.host, "Use auto-expiry");
      expect(mutations).toEqual([
        { url: "/api/files/F-DEF45", body: { durable: false } },
      ]);
      expect(
        view.host.querySelector('[aria-label="File detail"]')?.textContent,
      ).toContain("Temporary");
    } finally {
      await view.unmount();
    }
  },
);
it.each([admin, key])(
  "prevents $type from creating persistence when policy is disabled",
  async (principal) => {
    const mutations = setup(principal, false, false);
    const view = await render(<App />);
    try {
      const button = [...view.host.querySelectorAll("button")].find(
        (el) => el.textContent === "Persistence unavailable",
      )!;
      expect(button.disabled).toBe(true);
      await click(view.host, "Persistence unavailable");
      expect(mutations).toEqual([]);
    } finally {
      await view.unmount();
    }
  },
);
it.each([true, false])(
  "prevents a key without retention authority from mutating durable=%s in either policy",
  async (durable) => {
    for (const allowPersistent of [true, false]) {
      const mutations = setup(
        { ...key, canMarkDurable: false },
        allowPersistent,
        durable,
      );
      const view = await render(<App />);
      try {
        const label = durable ? "Use auto-expiry" : "Persistence unavailable";
        const button = [...view.host.querySelectorAll("button")].find(
          (el) => el.textContent === label,
        )!;
        expect(button.disabled).toBe(true);
        await click(view.host, label);
        expect(mutations).toEqual([]);
      } finally {
        await view.unmount();
      }
    }
  },
);
it.each([admin, key])(
  "allows authorized $type to create persistence when policy allows it",
  async (principal) => {
    const mutations = setup(principal, true, false);
    const view = await render(<App />);
    try {
      await click(view.host, "Keep indefinitely");
      expect(mutations).toEqual([
        { url: "/api/files/F-DEF45", body: { durable: true } },
      ]);
      expect(
        view.host.querySelector('[aria-label="File detail"]')?.textContent,
      ).toContain("Kept");
    } finally {
      await view.unmount();
    }
  },
);
