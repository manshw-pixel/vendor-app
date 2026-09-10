import { describe, it, expect } from "vitest";
import {
  validateItem, validateSettings, validateNewStaff, canEditStaff, stockLevel, LOW_STOCK_KG,
} from "../adminRules";
import { MIN_PASSWORD_LENGTH } from "../../../supabase/functions/admin-create-user/guards";

const item = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: "40", stock_kg: "12.5" };

describe("validateItem", () => {
  it("accepts a complete item and returns numbers, not strings", () => {
    const r = validateItem(item);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({
      name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5,
    });
  });

  it("requires all three names", () => {
    // §11b: a shopkeeper's own Marathi is the only native-quality Indian-language text
    // this app will ever hold, and a blank never gets filled in later.
    const r = validateItem({ ...item, name_hi: "", name_mr: "  " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["name_hi", "name_mr"]);
  });

  it("reports every problem at once", () => {
    const r = validateItem({ name_en: "", name_hi: "", name_mr: "", price: "x", stock_kg: "-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort())
      .toEqual(["name_en", "name_hi", "name_mr", "price", "stock_kg"]);
  });

  it("accepts zero price and zero stock", () => {
    // 0001_schema.sql checks price >= 0 and stock_kg >= 0, not > 0. A free item and a
    // sold-out item are both legitimate.
    expect(validateItem({ ...item, price: "0", stock_kg: "0" }).ok).toBe(true);
  });

  it("rejects a negative price or stock", () => {
    expect(validateItem({ ...item, price: "-1" }).ok).toBe(false);
    expect(validateItem({ ...item, stock_kg: "-0.5" }).ok).toBe(false);
  });

  it("trims the names it returns", () => {
    const r = validateItem({ ...item, name_en: "  Onion  " });
    if (r.ok) expect(r.value.name_en).toBe("Onion");
  });

  it("rejects a 20-digit price", () => {
    expect(validateItem({ ...item, price: "12345678901234567890" }).ok).toBe(false);
  });

  it("accepts the maximum numeric(10,2) value for price", () => {
    expect(validateItem({ ...item, price: "99999999.99" }).ok).toBe(true);
  });

  it("rejects a price exceeding the maximum numeric(10,2) value", () => {
    expect(validateItem({ ...item, price: "100000000" }).ok).toBe(false);
  });
});

describe("validateSettings", () => {
  const ok = {
    points_threshold_1: "600", points_reward_1: "50",
    points_threshold_2: "1000", points_reward_2: "100", redeem_days: "30",
  };

  it("accepts the schema defaults", () => {
    const r = validateSettings(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.points_threshold_1).toBe(600);
  });

  it("requires the second target to exceed the first", () => {
    // complete_bill() awards reward_2 when the total clears threshold_2; an inverted
    // pair makes the first tier unreachable and is a config mistake, not a policy.
    const r = validateSettings({ ...ok, points_threshold_2: "500" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.points_threshold_2).toBeTruthy();
  });

  it("rejects an equal pair", () => {
    expect(validateSettings({ ...ok, points_threshold_2: "600" }).ok).toBe(false);
  });

  it("requires whole numbers for rewards and days", () => {
    // points_reward_1 and redeem_days are integer columns; 2.5 would be silently
    // truncated by Postgres.
    expect(validateSettings({ ...ok, points_reward_1: "2.5" }).ok).toBe(false);
    expect(validateSettings({ ...ok, redeem_days: "30.5" }).ok).toBe(false);
  });

  it("allows a fractional threshold", () => {
    // thresholds are numeric(10,2) -- rupees and paise.
    expect(validateSettings({ ...ok, points_threshold_1: "599.50" }).ok).toBe(true);
  });

  it("rejects zero and negative values", () => {
    expect(validateSettings({ ...ok, redeem_days: "0" }).ok).toBe(false);
    expect(validateSettings({ ...ok, points_reward_1: "-5" }).ok).toBe(false);
  });

  it("rejects blanks and non-numbers", () => {
    const r = validateSettings({ ...ok, points_threshold_1: "", points_reward_2: "lots" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort())
      .toEqual(["points_reward_2", "points_threshold_1"]);
  });

  it("rejects a 20-digit threshold", () => {
    expect(validateSettings({ ...ok, points_threshold_1: "12345678901234567890" }).ok).toBe(false);
  });

  it("accepts the maximum numeric(10,2) value for threshold", () => {
    expect(validateSettings({ ...ok, points_threshold_2: "99999999.99" }).ok).toBe(true);
  });

  it("rejects a threshold exceeding the maximum numeric(10,2) value", () => {
    expect(validateSettings({ ...ok, points_threshold_2: "100000000" }).ok).toBe(false);
  });
});

describe("canEditStaff", () => {
  it("lets an admin edit someone else", () => {
    expect(canEditStaff("me", "them")).toBe(true);
  });

  it("refuses self-edit", () => {
    // The one action that locks a vendor out of its own tenant: users_admin_write needs
    // current_user_role() = 'admin', so a last admin who demotes themselves leaves
    // nobody able to undo it, and the repair is hand-written SQL against production.
    expect(canEditStaff("me", "me")).toBe(false);
  });
});

describe("stockLevel", () => {
  it("calls zero out of stock", () => {
    expect(stockLevel(0)).toBe("out");
  });

  it("calls anything at or under the threshold low", () => {
    expect(stockLevel(LOW_STOCK_KG)).toBe("low");
    expect(stockLevel(0.5)).toBe("low");
  });

  it("calls a healthy figure ok", () => {
    expect(stockLevel(LOW_STOCK_KG + 0.01)).toBe("ok");
  });
});

describe("validateNewStaff", () => {
  const good = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" };

  it("accepts a well-formed row", () => {
    const r = validateNewStaff(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(good);
  });

  it("rejects something that is not an email address", () => {
    const r = validateNewStaff({ ...good, email: "rina" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.email).toBe("staff.badEmail");
  });

  it("lowercases the email, because GoTrue treats it case-insensitively", () => {
    const r = validateNewStaff({ ...good, email: "Rina@Shop.Test" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.email).toBe("rina@shop.test");
  });

  it("rejects a password below the shared floor", () => {
    const r = validateNewStaff({ ...good, password: "short" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.password).toBe("staff.badPassword");
  });

  it("takes its floor from the same constant the function enforces", () => {
    // Two independent numbers would drift, and the drift shows up as the server rejecting
    // what the form accepted -- with the field message already dismissed.
    const atFloor = { ...good, password: "a".repeat(MIN_PASSWORD_LENGTH) };
    expect(validateNewStaff(atFloor).ok).toBe(true);
    const below = { ...good, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) };
    expect(validateNewStaff(below).ok).toBe(false);
  });

  it("never trims the password", () => {
    const r = validateNewStaff({ ...good, password: " pass word " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe(" pass word ");
  });

  it("rejects a blank name", () => {
    const r = validateNewStaff({ ...good, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBe("staff.required");
  });

  it("rejects a role the check constraint would refuse", () => {
    const r = validateNewStaff({ ...good, role: "owner" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.role).toBe("staff.badRole");
  });

  it("reports every bad field at once", () => {
    const r = validateNewStaff({ email: "x", password: "", name: "", role: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(["email", "name", "password", "role"]);
    }
  });
});
