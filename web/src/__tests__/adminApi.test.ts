import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { message?: string; context?: Response } | null;
}> => ({ data: { id: "u9" }, error: null }));

vi.mock("../supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

const { createUserAccount, deleteUserAccount } = await import("../adminApi");

const value = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" as const };

beforeEach(() => vi.clearAllMocks());

describe("createUserAccount", () => {
  it("invokes the function with the credentials as the body", async () => {
    await createUserAccount(value);
    expect(invoke).toHaveBeenCalledWith("admin-create-user", { body: value });
  });

  it("sends no vendor id -- the function reads it from the caller's own session", async () => {
    // If the client could name a vendor, an admin could create staff in another shop.
    await createUserAccount(value);
    const body = (invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).sort()).toEqual(["email", "name", "password", "role"]);
  });

  it("reports success as a null error", async () => {
    expect((await createUserAccount(value)).error).toBeNull();
  });

  it("names an address that is already taken", async () => {
    // The ordinary case of adding someone twice. A generic failure here would send the
    // admin looking for a problem that is only "they are already here".
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code",
               context: new Response(JSON.stringify({ error: "email_taken" }), { status: 409 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.emailTaken");
  });

  it("names a refused caller", async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "non-2xx",
               context: new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.notAllowed");
  });

  it("does not say nothing was saved when linking failed", async () => {
    // link_failed means the auth account was created and then the link step (or its
    // compensating delete) failed -- the account may still exist, so "nothing was saved"
    // would be a lie here. It gets its own key rather than sharing create_failed's.
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "non-2xx",
               context: new Response(JSON.stringify({ error: "link_failed" }), { status: 500 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.staffPartlyCreated");
  });

  it("falls back to unknown when the body is not one of our codes", async () => {
    // A 500 from the platform itself, or a gateway, carries no { error } body at all.
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "boom", context: new Response("<html>502</html>", { status: 502 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.unknown");
  });

  it("reports a dead network as offline, not as a rejected request", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    expect((await createUserAccount(value)).error?.key).toBe("error.offline");
  });
});

describe("deleteUserAccount", () => {
  const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  const refused = (code: string, status: number) => ({
    data: null,
    error: { message: "non-2xx", context: new Response(JSON.stringify({ error: code }), { status }) },
  });

  it("sends only the id", async () => {
    await deleteUserAccount(ID);
    expect(invoke).toHaveBeenCalledWith("admin-delete-user", { body: { id: ID } });
  });

  it("keeps the has-history message the direct delete used to produce", async () => {
    // bills.recorder_id/biller_id reference app_users with no ON DELETE clause, so this is
    // the common failure in a working shop. It read as "cannot be removed, change their
    // role instead" before this went through a function, and must still.
    invoke.mockResolvedValueOnce(refused("has_history", 409));
    expect((await deleteUserAccount(ID)).error?.key).toBe("error.staffHasHistory");
  });

  it("distinguishes a half-done removal from an outright failure", async () => {
    // account_delete_failed means the roster row IS gone and the email is still taken.
    // Collapsing it into a generic failure would leave an admin unable to explain why
    // re-adding that address is refused.
    invoke.mockResolvedValueOnce(refused("account_delete_failed", 500));
    expect((await deleteUserAccount(ID)).error?.key).toBe("error.staffPartlyRemoved");
  });

  it("reports a target in another shop as simply not on the list", async () => {
    invoke.mockResolvedValueOnce(refused("not_your_staff", 404));
    expect((await deleteUserAccount(ID)).error?.key).toBe("error.staffNotFound");
  });

  it("reports self-deletion as not allowed", async () => {
    invoke.mockResolvedValueOnce(refused("cannot_delete_self", 409));
    expect((await deleteUserAccount(ID)).error?.key).toBe("error.notAllowed");
  });

  it("does not resolve a delete code against the create function's key map", async () => {
    // The two functions have different ErrorCode unions and each gets its own map. A single
    // shared map would have to be their union, and a code meaningful to one would then
    // silently pick up the other's message.
    invoke.mockResolvedValueOnce(refused("email_taken", 409));
    expect((await deleteUserAccount(ID)).error?.key).toBe("error.unknown");
  });
});
