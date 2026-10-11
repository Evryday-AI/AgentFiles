// @vitest-environment jsdom
import { expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { FileDetail } from "../../src/client/components/FileDetail";
import { MediaPreview } from "../../src/client/components/MediaPreview";
import { App } from "../../src/client/App";
import { click, input, render } from "./dom";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  document.body.replaceChildren();
});
export const file = {
  code: "F-ABC23",
  name: "synthetic.txt",
  mime_type: "text/plain",
  size: 8,
  size_bytes: 8,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  expiry: "2030-01-01T00:00:00Z",
  expires_at: "2030-01-01T00:00:00Z",
  durable: false,
  is_durable: false,
  sha256: "a".repeat(64),
  private_url: "https://files.example.test/files/F-ABC23",
  api_download_url: "https://files.example.test/api/files/F-ABC23/download",
  uploaded_by: { type: "admin", name: "fixture" },
  metadata: {},
};
function setup(status = 200) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
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
                  : status === 200
                    ? file
                    : { error: "synthetic" },
          ),
          { status: url === `/api/files/${file.code}` ? status : 200 },
        ),
    ),
  );
}
it("looks up an exact code absent from the listed page", async () => {
  setup();
  const v = await render(<App />);
  await input(v.host, "File code", file.code);
  await click(v.host, "Find file");
  expect(v.host.textContent).toContain(file.name);
  expect(fetch).toHaveBeenCalledWith(
    `/api/files/${file.code}`,
    expect.anything(),
  );
  await v.unmount();
});
it.each([
  [401, "Sign in"],
  [403, "permission"],
  [404, "missing"],
  [410, "expired"],
])("preserves lookup status %i", async (status, message) => {
  setup(Number(status));
  history.replaceState(null, "", `/files/${file.code}`);
  const v = await render(<App />);
  expect(v.host.textContent).toContain(message);
  await v.unmount();
});
it("rejects malformed code before an HTTP lookup", async () => {
  setup();
  const v = await render(<App />);
  await input(v.host, "File code", "bad");
  await click(v.host, "Find file");
  expect(v.host.textContent).toContain("F-");
  expect(fetch).not.toHaveBeenCalledWith("/api/files/bad", expect.anything());
  await v.unmount();
});
it("does not replace a newer selection with an earlier slow lookup", async () => {
  setup();
  const other = { ...file, code: "F-XYZ23", name: "second.txt" };
  let finish!: (r: Response) => void;
  const previous = fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url === `/api/files/${file.code}`
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : url === `/api/files/${other.code}`
        ? Promise.resolve(new Response(JSON.stringify(other)))
        : previous(url, init),
  );
  const v = await render(<App />);
  await input(v.host, "File code", file.code);
  await click(v.host, "Find file");
  // The existing Refresh action rechecks a different selected file only after a
  // second form submission. Submit dispatch models a changed handoff while the
  // first HTTP response is pending, without assuming request cancellation.
  await input(v.host, "File code", other.code);
  await act(async () =>
    v.host
      .querySelector(".code-lookup")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await act(async () => finish(new Response(JSON.stringify(file))));
  expect(
    v.host.querySelector('[aria-label="File detail"]')?.textContent,
  ).toContain(other.name);
  expect(
    v.host.querySelector('[aria-label="File detail"]')?.textContent,
  ).not.toContain(file.name);
  await v.unmount();
});
it("closes the native preview when the selected file changes", async () => {
  const onError = vi.fn(),
    onMutated = vi.fn();
  const props = {
    onCopy: () => {},
    onClose: () => {},
    onError,
    onMutated,
    canChangeRetention: false,
    canPersist: false,
  };
  const v = await render(
    <FileDetail {...props} file={{ ...file, mime_type: "image/png" }} />,
  );
  await click(v.host, "Open larger preview");
  expect(v.host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  // Re-render the same detail component to cover callers which do not key it.
  await v.rerender(
    <FileDetail
      {...props}
      file={{
        ...file,
        code: "F-XYZ23",
        name: "different.png",
        mime_type: "image/png",
      }}
    />,
  );
  expect(v.host.querySelector("dialog")?.hasAttribute("open")).toBe(false);
  await v.unmount();
});
it("resets a failed media preview on a new file", async () => {
  const v = await render(
    <MediaPreview file={{ ...file, mime_type: "image/png" }} />,
  );
  await act(async () =>
    v.host.querySelector("img")!.dispatchEvent(new Event("error")),
  );
  expect(v.host.textContent).toContain("Preview unavailable");
  await v.rerender(
    <MediaPreview
      file={{ ...file, code: "F-XYZ23", mime_type: "image/png" }}
    />,
  );
  expect(v.host.querySelector("img")).toBeTruthy();
  await v.unmount();
});
it("keeps gallery order when selecting an already listed file", async () => {
  setup();
  const other = { ...file, code: "F-XYZ23", name: "second.txt" };
  const previous = fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url.startsWith("/api/files?")
      ? Promise.resolve(new Response(JSON.stringify({ files: [file, other] })))
      : url === `/api/files/${other.code}`
        ? Promise.resolve(new Response(JSON.stringify(other)))
        : previous(url, init),
  );
  const v = await render(<App />);
  await click(v.host, other.name);
  expect(
    v.host.querySelector(".file-tile .file-name-button")?.textContent,
  ).toBe(file.name);
  await v.unmount();
});

it.each([
  [403, 200],
  [500, 410],
])(
  "starts initial exact lookup independently of list status %i and preserves file status %i",
  async (listStatus, fileStatus) => {
    setup(fileStatus);
    history.replaceState(null, "", `/files/${file.code}`);
    const previous = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) =>
        url.startsWith("/api/files?")
          ? Promise.resolve(
              new Response(JSON.stringify({ error: "list failure" }), {
                status: listStatus,
              }),
            )
          : previous(url, init),
      ),
    );
    const view = await render(<App />);
    try {
      expect(fetch).toHaveBeenCalledWith(
        `/api/files/${file.code}`,
        expect.anything(),
      );
      if (fileStatus === 200) {
        expect(
          view.host.querySelector('[aria-label="File detail"]')?.textContent,
        ).toContain(file.name);
      } else {
        expect(view.host.textContent).toContain("expired (410)");
        expect(view.host.textContent).not.toContain("File refresh failed");
      }
    } finally {
      await view.unmount();
    }
  },
);
it("keeps initial exact metadata when a slow list returns stale metadata for the same code", async () => {
  setup();
  history.replaceState(null, "", `/files/${file.code}`);
  const previous = fetch;
  let finishList!: (value: Response) => void;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url.startsWith("/api/files?")
      ? new Promise<Response>((resolve) => {
          finishList = resolve;
        })
      : previous(url, init),
  );
  const view = await render(<App />);
  try {
    expect(
      view.host.querySelector('[aria-label="File detail"]')?.textContent,
    ).toContain(file.name);
    await act(async () =>
      finishList(
        new Response(
          JSON.stringify({
            files: [
              { ...file, name: "stale-list.txt" },
              { ...file, code: "F-XYZ23", name: "newer-list.txt" },
            ],
          }),
        ),
      ),
    );
    expect(
      view.host.querySelector('[aria-label="File detail"]')?.textContent,
    ).toContain(file.name);
    expect(view.host.textContent).not.toContain("stale-list.txt");
    expect(view.host.textContent).toContain("newer-list.txt");
  } finally {
    await act(async () =>
      finishList(new Response(JSON.stringify({ files: [] }))),
    );
    await view.unmount();
  }
});

it.each([
  [404, "missing"],
  [410, "expired"],
])(
  "keeps unrelated list results after a fast initial metadata %i",
  async (status, message) => {
    setup(Number(status));
    history.replaceState(null, "", `/files/${file.code}`);
    const other = { ...file, code: "F-XYZ23", name: "unrelated.txt" };
    const previous = fetch;
    let finishList!: (value: Response) => void;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      url.startsWith("/api/files?")
        ? new Promise<Response>((resolve) => {
            finishList = resolve;
          })
        : previous(url, init),
    );
    const view = await render(<App />);
    try {
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
        message,
      );
      await act(async () =>
        finishList(new Response(JSON.stringify({ files: [file, other] }))),
      );
      expect(
        view.host.querySelector(".file-tile .file-name-button")?.textContent,
      ).toBe(other.name);
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
        message,
      );
      expect(view.host.querySelector('[aria-label="File detail"]')).toBeNull();
      expect(view.host.textContent).not.toContain(file.name);
    } finally {
      await act(async () =>
        finishList(new Response(JSON.stringify({ files: [] }))),
      );
      await view.unmount();
    }
  },
);
it("does not merge an old initial list over a newer selection after an initial failure", async () => {
  setup(404);
  history.replaceState(null, "", `/files/${file.code}`);
  const other = { ...file, code: "F-XYZ23", name: "new exact result.txt" };
  const previous = fetch;
  let finishList!: (value: Response) => void;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url.startsWith("/api/files?")
      ? new Promise<Response>((resolve) => {
          finishList = resolve;
        })
      : url === `/api/files/${other.code}`
        ? Promise.resolve(new Response(JSON.stringify(other)))
        : previous(url, init),
  );
  const view = await render(<App />);
  await input(view.host, "File code", other.code);
  await click(view.host, "Find file");
  await act(async () =>
    finishList(
      new Response(
        JSON.stringify({
          files: [file, { ...other, name: "stale list result.txt" }],
        }),
      ),
    ),
  );
  expect(
    view.host.querySelector('[aria-label="File detail"]')?.textContent,
  ).toContain(other.name);
  expect(view.host.textContent).not.toContain("stale list result.txt");
  expect(view.host.querySelector('[role="alert"]')).toBeNull();
  await view.unmount();
});
