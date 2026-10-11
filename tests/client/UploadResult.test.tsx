// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { App } from "../../src/client/App";
import { UploadResult } from "../../src/client/components/UploadResult";
import { uploadFile } from "../../src/client/api";
import { click, render } from "./dom";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const file = {
  code: "F-ABC23",
  name: "fixture.txt",
  mime_type: "text/plain",
  size: 8,
  size_bytes: 8,
  created_at: "2026-10-11T00:00:00Z",
  updated_at: "2026-10-11T00:00:00Z",
  expiry: "2026-10-18T00:00:00Z",
  expires_at: "2026-10-18T00:00:00Z",
  durable: false,
  is_durable: false,
  sha256: "a".repeat(64),
  private_url: "https://files.example.test/files/F-ABC23",
  api_download_url: "https://files.example.test/api/files/F-ABC23/download",
  uploaded_by: { type: "admin" as const, name: "fixture" },
  metadata: {},
};
it("disables persistence when the instance forbids it", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === "/api/auth/session"
            ? {
                authenticated: true,
                principal: { type: "admin", name: "fixture" },
              }
            : url === "/api/instance"
              ? { allow_persistent_files: false }
              : { files: [] },
        ),
      ),
  );
  const v = await render(<App />);
  expect(
    v.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
  ).toBe(true);
  await v.unmount();
  vi.unstubAllGlobals();
});
it("retains exact expiry, checksum and private URL without creating a public share", async () => {
  const copy = vi.fn();
  vi.stubGlobal("fetch", vi.fn());
  const v = await render(<UploadResult file={file} onCopy={copy} />);
  expect(v.host.textContent).toContain(file.expires_at);
  expect(v.host.textContent).toContain(file.sha256);
  await click(v.host, "Copy code");
  expect(copy).toHaveBeenLastCalledWith(file.code, "Code copied");
  await click(v.host, "Copy private link");
  expect(copy).toHaveBeenLastCalledWith(
    file.private_url,
    "Private link copied",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(v.host.querySelector("a")?.href).toBe(file.private_url);
  await v.unmount();
});
it("shows explicit persistent state only from the returned durable result", async () => {
  const v = await render(
    <UploadResult
      file={{
        ...file,
        durable: true,
        is_durable: true,
        expiry: null,
        expires_at: null,
      }}
      onCopy={() => {}}
    />,
  );
  expect(v.host.textContent).toContain(
    "Persistent: kept indefinitely by explicit request",
  );
  await v.unmount();
});
it("reports response loss as an unknown upload outcome and sends only once", async () => {
  let xhr: { onerror: () => void; send: ReturnType<typeof vi.fn> };
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      upload = {};
      open() {}
      send = vi.fn(() => queueMicrotask(() => this.onerror()));
      onerror = () => {};
      constructor() {
        xhr = this;
      }
    },
  );
  await expect(
    uploadFile(new File(["synthetic"], "fixture.txt")),
  ).rejects.toThrow("Upload outcome unknown");
  expect(xhr!.send).toHaveBeenCalledTimes(1);
});
it("treats a malformed success response as unknown rather than recording a completed upload", async () => {
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      upload = {};
      status = 201;
      response = null;
      open() {}
      send() {
        queueMicrotask(() => this.onload());
      }
      onload = () => {};
    },
  );
  await expect(
    uploadFile(new File(["synthetic"], "fixture.txt")),
  ).rejects.toThrow("Upload outcome unknown");
});
it("selects the full completed upload even when an earlier library refresh is discarded", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === "/api/auth/session"
            ? {
                authenticated: true,
                principal: { type: "admin", name: "fixture" },
              }
            : url === "/api/instance"
              ? { allow_persistent_files: false }
              : url.startsWith("/api/files?")
                ? { files: [] }
                : file,
        ),
      ),
  );
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      upload = {};
      status = 201;
      response = file;
      open() {}
      send() {
        queueMicrotask(() => this.onload());
      }
      onload = () => {};
    },
  );
  const view = await render(<App />);
  const control =
    view.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(control, "files", {
    value: [new File(["synthetic"], "fixture.txt")],
  });
  await act(async () =>
    control.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(
    view.host.querySelector('[aria-label="File detail"]')?.textContent,
  ).toContain(file.name);
  await view.unmount();
});
