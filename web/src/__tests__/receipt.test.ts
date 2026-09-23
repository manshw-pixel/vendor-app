import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const responses = { bills: {} as Row, lines: [] as Row[], ledger: [] as Row[] };
const rpcResult = { data: [{ balance: 260, days_left: 15 }], error: null as unknown };
// Set only by the error-path test, to force the bills read to fail without fighting
// vi.mock's module replacement (a vi.spyOn over an already-mocked module is unreliable).
const billsError = { value: null as unknown };

const captured: {
  tables: string[];
  selects: string[];
  eqs: [string, unknown[]][];
  ins: [string, unknown[]][];
} = { tables: [], selects: [], eqs: [], ins: [] };

const make = (table: string) => {
  const o: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "gt", "order", "limit"]) {
    o[k] = (...a: unknown[]) => {
      if (k === "select") captured.selects.push(a[0] as string);
      if (k === "eq") captured.eqs.push([table, a]);
      if (k === "in") captured.ins.push([table, a]);
      return o;
    };
  }
  o.maybeSingle = async () =>
    billsError.value ? { data: null, error: billsError.value } : { data: responses.bills, error: null };
  (o as { then: unknown }).then = (res: (v: unknown) => unknown) => {
    const data = table === "bill_items" ? responses.lines : responses.ledger;
    return Promise.resolve({ data, error: null }).then(res);
  };
  return o;
};

vi.mock("../supabase", () => ({
  supabase: {
    from: (t: string) => { captured.tables.push(t); return make(t); },
    rpc: async () => rpcResult,
  },
}));

const { loadReceipt } = await import("../receipt");

const BILL = {
  token_no: 147,
  completed_at: "2026-09-17T14:12:00.000Z",
  total: "166.00",
  redeemed_points: 50,
  customers: { name: "Sunita Kale", flat_no: "B-304" },
  app_users: { name: "Sunil" },
  vendors: { name: "Taji Bhaji", address: "Shop 12", phone: "9876543210" },
};

beforeEach(() => {
  captured.tables = [];
  captured.selects = [];
  captured.eqs = [];
  captured.ins = [];
  responses.bills = { ...BILL };
  responses.lines = [
    { id: "l1", qty_kg: "2.5", unit_price: "40.00", line_total: "100.00",
      items: { name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो", unit: "kg" } },
  ];
  responses.ledger = [{ points: 0 }];
  rpcResult.data = [{ balance: 260, days_left: 15 }];
  rpcResult.error = null;
  billsError.value = null;
});

describe("loadReceipt", () => {
  it("selects each line's item unit", async () => {
    await loadReceipt("b1");
    expect(captured.selects.some((c) => c.includes("items(name_en, name_hi, name_mr, unit)"))).toBe(true);
  });


  it("computes gross as the net plus the points redeemed", async () => {
    // bills.total is the NET (0010). Printing it as the subtotal shows the discount
    // twice: once in the subtotal and again on the redemption line.
    const { data } = await loadReceipt("b1");
    expect(data!.net).toBe(166);
    expect(data!.gross).toBe(216);
  });

  it("leaves gross equal to net when nothing was redeemed", async () => {
    responses.bills = { ...BILL, total: "216.00", redeemed_points: 0 };
    const { data } = await loadReceipt("b1");
    expect(data!.gross).toBe(216);
    expect(data!.net).toBe(216);
  });

  it("coerces PostgREST's numeric-as-string to numbers", async () => {
    // numeric arrives as text to avoid float rounding. Left as strings, "100.00" + 0
    // concatenates and the slip prints nonsense.
    const { data } = await loadReceipt("b1");
    const line = data!.lines[0]!;
    expect(line.qty_kg).toBe(2.5);
    expect(line.unit_price).toBe(40);
    expect(line.line_total).toBe(100);
  });

  it("reads points earned from the ledger rather than recomputing the rule", async () => {
    responses.ledger = [{ points: 50 }];
    const { data } = await loadReceipt("b1");
    expect(data!.points_earned).toBe(50);
    expect(captured.tables).toContain("points_ledger");
  });

  it("reports zero points earned when the bill awarded none", async () => {
    // A 216 bill that redeemed 50 nets 166, under the 600 threshold. Earning nothing is
    // correct: complete_bill measures thresholds against the net.
    responses.ledger = [];
    const { data } = await loadReceipt("b1");
    expect(data!.points_earned).toBe(0);
  });

  it("renders a walk-in bill with no customer", async () => {
    responses.bills = { ...BILL, customers: null };
    const { data } = await loadReceipt("b1");
    expect(data!.customer).toBeNull();
    expect(data!.balance).toBeNull();
  });

  it("survives a bill whose biller name is missing", async () => {
    responses.bills = { ...BILL, app_users: null };
    const { data } = await loadReceipt("b1");
    expect(data!.biller_name).toBeNull();
    expect(data!.token_no).toBe(147);
  });

  it("carries the shop header through", async () => {
    const { data } = await loadReceipt("b1");
    expect(data!.shop).toEqual({ name: "Taji Bhaji", address: "Shop 12", phone: "9876543210" });
  });

  it("only ever reads a completed or voided bill, never a pending one", async () => {
    // A pending bill has no completed_at and no collected total; printing one would show
    // "Paid" for money never taken. The id is a uuid so this is not reachable through the
    // UI, but the query itself must not trust that.
    await loadReceipt("b1");
    const billsFilters = captured.ins.filter(([table]) => table === "bills");
    expect(billsFilters).toContainEqual(["bills", ["status", ["done", "voided"]]]);
  });

  it("marks a voided bill's receipt with its reason", async () => {
    responses.bills = {
      ...BILL,
      status: "voided",
      voided_at: "2026-09-18T09:00:00.000Z",
      void_reason: "typed twice",
    };
    const { data } = await loadReceipt("b1");
    expect(data!.voided).toEqual({ at: "2026-09-18T09:00:00.000Z", reason: "typed twice" });
  });

  it("leaves voided null for a done bill", async () => {
    responses.bills = { ...BILL, status: "done", voided_at: null, void_reason: null };
    const { data } = await loadReceipt("b1");
    expect(data!.voided).toBeNull();
  });

  it("reads the payment mode, whether PostgREST embeds it as an object or an array", async () => {
    responses.bills = { ...responses.bills, bill_payments: { mode: "card" } };
    expect((await loadReceipt("b1")).data?.payment_mode).toBe("card");
    responses.bills = { ...responses.bills, bill_payments: [{ mode: "cash" }] };
    expect((await loadReceipt("b1")).data?.payment_mode).toBe("cash");
    responses.bills = { ...responses.bills, bill_payments: null };
    expect((await loadReceipt("b1")).data?.payment_mode).toBeNull();
  });

  it("returns the error and no data when the bill cannot be read", async () => {
    const boom = { message: "nope" };
    billsError.value = boom;
    const { data, error } = await loadReceipt("b1");
    expect(data).toBeNull();
    expect(error).toBe(boom);
  });
});
