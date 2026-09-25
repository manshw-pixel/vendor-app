import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import { OfflineChip } from "../components/OfflineChip";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("OfflineChip", () => {
  it("offline with 2 waiting, says so and links to the outbox", () => {
    render(<MemoryRouter><OfflineChip online={false} waiting={2} attention={0} /></MemoryRouter>);
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("Offline · 2 bills waiting to sync");
    expect(link.getAttribute("href")).toBe("/outbox");
  });
  it("online with nothing queued renders nothing", () => {
    const { container } = render(<MemoryRouter><OfflineChip online waiting={0} attention={0} /></MemoryRouter>);
    expect(container.innerHTML).toBe("");
  });
});
