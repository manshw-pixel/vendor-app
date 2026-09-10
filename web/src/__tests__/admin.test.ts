import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn((..._a: unknown[]) => ({
  select: () => ({ single: async () => ({ data: { id: "i1" }, error: null }) }),
}));
const eqUpdate = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const update = vi.fn((..._a: unknown[]) => ({ eq: (...b: unknown[]) => eqUpdate(...b) }));
const del = vi.fn((..._a: unknown[]) => ({ eq: (...b: unknown[]) => eqUpdate(...b) }));
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: 120, error: null }));
const from = vi.fn((..._a: unknown[]) => ({
  insert, update, delete: del,
  select: () => ({
    order: async () => ({ data: [], error: null }),
    eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
  }),
}));

vi.mock("../supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) },
}));

const {
  listAllItems, createItem, updateItem, setItemActive,
  updateCustomer, customerPoints, listStaff, updateStaff,
  loadVendorConfig, updateVendorConfig,
} = await import("../admin");

const value = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5 };

beforeEach(() => vi.clearAllMocks());

describe("listAllItems", () => {
  it("reads items without filtering is_active", async () => {
    // listItems() in data.ts hides inactive items from the bill grid on purpose. An
    // admin who cannot see a hidden item cannot bring it back.
    await listAllItems();
    expect(from).toHaveBeenCalledWith("items");
  });
});

describe("createItem", () => {
  it("stamps vendor_id", async () => {
    // NOT NULL with no default. Forgetting it has shipped as a bug once already.
    await createItem("v1", value);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: "v1", name_en: "Onion",
    }));
  });
});

describe("updateItem", () => {
  it("updates by id and never sends vendor_id", async () => {
    // RLS scopes the row; re-sending vendor_id would let a typo attempt a tenant move
    // that items_admin_write would refuse anyway.
    await updateItem("i1", value);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ price: 40 }));
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("vendor_id");
    expect(eqUpdate).toHaveBeenCalledWith("id", "i1");
  });
});

describe("setItemActive", () => {
  it("flips is_active rather than deleting", async () => {
    // bill_items.item_id references items; a delete would fail the FK or destroy the
    // history the dashboards read.
    await setItemActive("i1", false);
    expect(update).toHaveBeenCalledWith({ is_active: false });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("updateCustomer", () => {
  it("updates the three editable fields by id", async () => {
    await updateCustomer("c1", { name: "Asha", flat_no: "A-1", mobile: "+919000000000" });
    expect(from).toHaveBeenCalledWith("customers");
    expect(update).toHaveBeenCalledWith({ name: "Asha", flat_no: "A-1", mobile: "+919000000000" });
    expect(eqUpdate).toHaveBeenCalledWith("id", "c1");
  });
});

describe("customerPoints", () => {
  it("calls the function with the parameter name the migration declares", async () => {
    // 0003_functions.sql declares customer_points_balance(p_customer_id uuid).
    const r = await customerPoints("c1");
    expect(rpc).toHaveBeenCalledWith("customer_points_balance", { p_customer_id: "c1" });
    expect(r.data).toBe(120);
  });
});

describe("listStaff", () => {
  it("reads app_users", async () => {
    await listStaff();
    expect(from).toHaveBeenCalledWith("app_users");
  });
});

describe("updateStaff", () => {
  it("sends only the fields given", async () => {
    await updateStaff("u2", { role: "biller" });
    expect(update).toHaveBeenCalledWith({ role: "biller" });
    expect(eqUpdate).toHaveBeenCalledWith("id", "u2");
  });
});


describe("vendor config", () => {
  it("reads the vendor row by id", async () => {
    await loadVendorConfig("v1");
    expect(from).toHaveBeenCalledWith("vendors");
  });

  it("updates the five loyalty columns and nothing else", async () => {
    await updateVendorConfig("v1", {
      points_threshold_1: 600, points_reward_1: 50,
      points_threshold_2: 1000, points_reward_2: 100, redeem_days: 30,
    });
    expect(Object.keys(update.mock.calls[0]?.[0] as object).sort()).toEqual([
      "points_reward_1", "points_reward_2",
      "points_threshold_1", "points_threshold_2", "redeem_days",
    ]);
    expect(eqUpdate).toHaveBeenCalledWith("id", "v1");
  });
});
