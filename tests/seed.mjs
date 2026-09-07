// Builds two complete vendors, each with all three roles signed in. Everything the RLS
// suite asserts is "can A's session see or touch B's rows", so both worlds must be fully
// populated before a single assertion runs.
import { createClient } from "@supabase/supabase-js";
import { API_URL, ANON_KEY, SERVICE_KEY, PASSWORD, sql, newClient } from "./fixtures.mjs";

const admin = () => createClient(API_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeUser(email, vendorId, role, name) {
  // Create through GoTrue's admin API so the user is real and can sign in, then map them
  // to a vendor and role in app_users.
  const { data, error } = await admin().auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  const id = data.user.id;
  await sql(`insert into app_users (id, vendor_id, role, name) values ($1,$2,$3,$4)`,
    [id, vendorId, role, name]);

  const client = newClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn(${email}): ${signInError.message}`);
  return { id, client };
}

// Emails must be unique across the whole run: seedTwoVendors() is called by more than one
// test file, and GoTrue rejects a duplicate address.
let seq = 0;

async function makeVendor(tag) {
  const n = ++seq;
  const { rows: [v] } = await sql(`insert into vendors (name) values ($1) returning id`, [`Vendor ${tag}${n}`]);
  const vendorId = v.id;

  const adminU    = await makeUser(`admin-${tag}${n}@example.test`,    vendorId, "admin",    `Admin ${tag}`);
  const recorderU = await makeUser(`recorder-${tag}${n}@example.test`, vendorId, "recorder", `Recorder ${tag}`);
  const billerU   = await makeUser(`biller-${tag}${n}@example.test`,   vendorId, "biller",   `Biller ${tag}`);

  const { rows: [item] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,$2,$3,$4) returning id`,
    [vendorId, `Onion ${tag}`, 40, 100]);
  const { rows: [cust] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile) values ($1,$2,$3,$4) returning id`,
    [vendorId, `Cust ${tag}`, `A-10${n}`, `+9199999${String(n).padStart(5, "0")}`]);

  return {
    vendorId,
    adminId: adminU.id, recorderId: recorderU.id, billerId: billerU.id,
    itemId: item.id, customerId: cust.id,
    clients: { admin: adminU.client, recorder: recorderU.client, biller: billerU.client },
  };
}

export async function seedTwoVendors() {
  return { a: await makeVendor("A"), b: await makeVendor("B") };
}
