import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("../syncIssues", () => ({
  listSyncIssues: vi.fn(async () => ({ data: [
    { id: "s1", bill_id: "b1", token_no: 12, kind: "redeem_shortfall", amount: 20, detail: {}, created_at: "2026-09-25T10:00:00Z", customer_name: "Asha" },
    { id: "s2", bill_id: "b2", token_no: 13, kind: "time_clamped", amount: null, detail: {}, created_at: "2026-09-25T10:00:00Z", customer_name: null },
  ], error: null })),
  resolveSyncIssue: vi.fn(async () => ({ data: null, error: null })),
}));
const { default: SyncIssues } = await import("../screens/SyncIssues");
const api = await import("../syncIssues");
beforeEach(() => vi.clearAllMocks());

describe("sync issues", () => {
  it("offers Add as due only for a points shortfall", async () => {
    render(<SyncIssues />);
    await screen.findByText(/#12/);
    expect(screen.getAllByRole("button", { name: /add as due/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(2);
  });
  it("resolves and reloads", async () => {
    render(<SyncIssues />);
    fireEvent.click(await screen.findByRole("button", { name: /add as due/i }));
    await waitFor(() => expect(api.resolveSyncIssue).toHaveBeenCalledWith("s1", "add_as_due"));
    expect(api.listSyncIssues).toHaveBeenCalledTimes(2);
  });
});
