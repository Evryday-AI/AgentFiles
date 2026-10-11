import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect } from "vitest";
export async function render(node: ReactNode) {
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    async rerender(node: ReactNode) {
      await act(async () => root.render(node));
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
export async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  );
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => button!.click());
}
export async function input(host: HTMLElement, label: string, value: string) {
  const el = [...host.querySelectorAll("label")]
    .find((el) => el.textContent?.includes(label))
    ?.querySelector("input");
  expect(el, `input ${label}`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
export async function submit(host: HTMLElement) {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
