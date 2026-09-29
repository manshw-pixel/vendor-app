import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "../ui/Dialog";
import { Field } from "../ui/Field";

afterEach(cleanup);

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Dialog label="Confirm" onClose={() => { onClose?.(); setOpen(false); }}>
          <button>first</button>
          <button>last</button>
        </Dialog>
      )}
    </>
  );
}

function InitialFocusHarness() {
  const [open, setOpen] = useState(false);
  const lastRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Dialog label="Confirm" onClose={() => setOpen(false)} initialFocusRef={lastRef}>
          <button>first</button>
          <button ref={lastRef}>last</button>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("keeps the dialog markup contract", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    const d = screen.getByRole("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-label")).toBe("Confirm");
  });
  it("focuses the first control, closes on Escape, and returns focus", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText("open");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.textContent).toBe("first");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("focuses initialFocusRef instead of the first focusable when given", () => {
    render(<InitialFocusHarness />);
    fireEvent.click(screen.getByText("open"));
    expect(document.activeElement?.textContent).toBe("last");
  });
  it("traps Tab inside the dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    screen.getByText("last").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("first");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("last");
  });
});

describe("Field", () => {
  it("labels the control and describes it with hint and error", () => {
    render(
      <Field label="Weight" hint="kg" error="Too much">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}
      </Field>,
    );
    const input = screen.getByLabelText("Weight");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toEqual(["kg", "Too much"]);
  });
  it("omits aria-describedby when there is nothing to describe", () => {
    render(<Field label="Name">{({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}</Field>);
    expect(screen.getByLabelText("Name").hasAttribute("aria-describedby")).toBe(false);
  });
});
