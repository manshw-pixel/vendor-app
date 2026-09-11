import { describe, it, expect } from "vitest";
import {
  normaliseMobile, buildMessage, classifyFailure, MAX_ATTEMPTS,
} from "../../../supabase/functions/send-notification/sender";

describe("normaliseMobile", () => {
  it("accepts a bare ten-digit Indian mobile", () => {
    expect(normaliseMobile("9876543210")).toEqual({ ok: true, value: "whatsapp:+919876543210" });
  });

  it("strips the punctuation people actually type", () => {
    // customers.mobile is free text (0001_schema.sql) and has been since launch, so the
    // rows already in production carry every one of these shapes.
    for (const raw of ["98765 43210", "98765-43210", "(98765) 43210", " 9876543210 "]) {
      expect(normaliseMobile(raw)).toEqual({ ok: true, value: "whatsapp:+919876543210" });
    }
  });

  it("drops a leading zero", () => {
    expect(normaliseMobile("09876543210")).toEqual({ ok: true, value: "whatsapp:+919876543210" });
  });

  it("accepts numbers that already carry the country code", () => {
    for (const raw of ["+919876543210", "919876543210", "+91 98765 43210"]) {
      expect(normaliseMobile(raw)).toEqual({ ok: true, value: "whatsapp:+919876543210" });
    }
  });

  it("rejects anything it cannot turn into a real number", () => {
    // Rejected here means FAILED, not retried: no number of attempts fixes nine digits.
    for (const raw of ["", "   ", "987654321", "98765432101", "abcdefghij", "+1 555 0100"]) {
      expect(normaliseMobile(raw).ok).toBe(false);
    }
  });

  it("rejects a null or missing mobile without throwing", () => {
    // A bill can be raised against a customer row read back as null by a join miss; the
    // drain must classify that, not crash the whole batch.
    for (const raw of [null, undefined]) {
      expect(normaliseMobile(raw as unknown as string).ok).toBe(false);
    }
  });

  it("does not accept a ten-digit number that cannot start an Indian mobile", () => {
    // Indian mobiles begin 6-9. A landline pasted into the field would otherwise be
    // sent to Twilio and rejected there, one wasted attempt at a time.
    for (const raw of ["1234567890", "5876543210"]) {
      expect(normaliseMobile(raw).ok).toBe(false);
    }
  });
});

describe("buildMessage", () => {
  const sids = { token_issued: "HXtoken", points_awarded: "HXpoints" };

  it("maps token_issued to its content SID with token and total in order", () => {
    // Payload shape is fixed by issue_token() at 0003_functions.sql:54.
    const r = buildMessage("token_issued", { token_no: 7, total: 640.5 }, sids);
    expect(r).toEqual({
      ok: true,
      value: { contentSid: "HXtoken", variables: { "1": "7", "2": "640.50" } },
    });
  });

  it("maps points_awarded with points, net total and days to expiry", () => {
    // Payload shape is fixed by complete_bill() at 0010_points_redemption.sql:143.
    const r = buildMessage(
      "points_awarded",
      { points: 50, total: 610, redeemed: 0, expires_in_days: 30 },
      sids,
    );
    expect(r).toEqual({
      ok: true,
      value: { contentSid: "HXpoints", variables: { "1": "50", "2": "610.00", "3": "30" } },
    });
  });

  it("formats money to two decimals, never a bare integer or a float tail", () => {
    // numeric(10,2) arrives over PostgREST as a JS number: 640 must not read as "640"
    // in a customer's bill message, and 0.1+0.2 arithmetic must not leak digits.
    const r = buildMessage("token_issued", { token_no: 1, total: 640 }, sids);
    expect(r.ok && r.value.variables["2"]).toBe("640.00");
  });

  it("refuses a template key with no configured SID", () => {
    // TWILIO_CONTENT_SIDS is set by hand after Meta approves each template. A key added
    // to the database before the SID is configured must fail loudly, not send blank.
    const r = buildMessage("token_issued", { token_no: 1, total: 10 }, {});
    expect(r).toEqual({ ok: false, reason: "no_content_sid_for_token_issued" });
  });

  it("refuses a template key the sender does not know", () => {
    const r = buildMessage("expiry_reminder", {}, { expiry_reminder: "HXwhatever" });
    expect(r).toEqual({ ok: false, reason: "unknown_template_expiry_reminder" });
  });

  it("refuses a payload missing a variable the template needs", () => {
    // Sending a template with a hole in it is worse than not sending: the customer gets
    // a message with a blank where their token number should be.
    expect(buildMessage("token_issued", { total: 10 }, sids).ok).toBe(false);
    expect(buildMessage("token_issued", { token_no: 4 }, sids).ok).toBe(false);
    expect(buildMessage("points_awarded", { points: 50, total: 610 }, sids).ok).toBe(false);
  });

  it("refuses a payload whose numbers are not numbers", () => {
    expect(buildMessage("token_issued", { token_no: "seven", total: 10 }, sids).ok).toBe(false);
    expect(buildMessage("token_issued", { token_no: 7, total: null }, sids).ok).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("treats rate limiting and server errors as retryable", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyFailure(status)).toBe("retry");
    }
  });

  it("treats client errors as permanent", () => {
    // 400 is Twilio's answer to an unreachable number or a bad ContentSid; retrying
    // four more times changes nothing and delays every message queued behind it.
    for (const status of [400, 403, 404, 422]) {
      expect(classifyFailure(status)).toBe("permanent");
    }
  });

  it("treats 401 as retryable despite being a 4xx", () => {
    // A rotated or briefly-wrong TWILIO_AUTH_TOKEN is an operator mistake that gets
    // fixed. Burning the queue to `failed` in the minutes before someone notices would
    // lose real bills' messages with no way to replay them.
    expect(classifyFailure(401)).toBe("retry");
  });

  it("treats a thrown fetch (no status at all) as retryable", () => {
    expect(classifyFailure(null)).toBe("retry");
  });
});

describe("MAX_ATTEMPTS", () => {
  it("is a small positive cap", () => {
    // The claim query filters on attempts < MAX_ATTEMPTS; a zero or negative value would
    // silently claim nothing and the queue would sit still with no error anywhere.
    expect(MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
