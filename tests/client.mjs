// A stand-in for @supabase/supabase-js, speaking SQL to the native PostgreSQL server
// instead of HTTP to PostgREST and GoTrue.
//
// It exists so the test files do not have to be rewritten: they use nine methods --
// from/select/insert/update/delete/eq/rpc plus auth.signInWithPassword and
// auth.admin.createUser -- and this implements exactly those, returning the same
// { data, error } shape. Anything beyond that slice throws rather than guessing, so an
// unsupported call fails loudly instead of silently passing.
//
// The important part is not the API shape but the SESSION: each client holds its own
// connection, does `set role authenticated`, and sets `request.jwt.claims` to its user.
// That is what makes RLS actually apply. A superuser connection bypasses RLS entirely,
// which is how an earlier shim run "verified" the schema while testing none of the
// security model.
import pg from "pg";

// PostgREST reports a policy-blocked write as an error; a policy-filtered read simply
// returns no rows. Postgres does the same -- 42501 on the write, zero rows on the read --
// so assertDenied/assertInvisible keep their meanings. This is the one place the
// correspondence matters, so it is named rather than left implicit.
const toResult = (rows) => ({ data: rows, error: null });
const toError = (e) => ({ data: null, error: { message: e.message, code: e.code } });

const ident = (name) => {
  // Table and column names come from the tests, not from user input, but a broken name
  // should fail here rather than compose into surprising SQL.
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};

// Builds one statement, then runs it when awaited. Thenable rather than async so the
// chain (.from().select().eq()) can be awaited at any point, like supabase-js.
class Query {
  #run; #table; #verb = "select"; #columns = "*"; #values = null; #filters = [];

  constructor(run, table) { this.#run = run; this.#table = table; }

  select(columns = "*") {
    // After insert/update/delete, .select() asks for the affected rows back; on its own
    // it starts a read.
    if (this.#verb === "select") this.#columns = columns;
    this.#returning = columns;
    return this;
  }
  insert(values) { this.#verb = "insert"; this.#values = values; return this; }
  update(values) { this.#verb = "update"; this.#values = values; return this; }
  delete() { this.#verb = "delete"; return this; }
  eq(column, value) { this.#filters.push([column, value]); return this; }

  #returning = null;

  #where(params) {
    if (!this.#filters.length) return "";
    const clauses = this.#filters.map(([col, val]) => {
      params.push(val);
      return `${ident(col)} = $${params.length}`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  #build() {
    const params = [];
    const t = ident(this.#table);
    switch (this.#verb) {
      case "select": {
        const cols = this.#columns === "*" ? "*" :
          this.#columns.split(",").map(c => ident(c.trim())).join(", ");
        return [`select ${cols} from ${t}${this.#where(params)}`, params];
      }
      case "insert": {
        const rows = Array.isArray(this.#values) ? this.#values : [this.#values];
        const cols = Object.keys(rows[0]);
        const tuples = rows.map(row => {
          const placeholders = cols.map(c => { params.push(row[c]); return `$${params.length}`; });
          return `(${placeholders.join(", ")})`;
        });
        const returning = this.#returning ? " returning *" : "";
        return [`insert into ${t} (${cols.map(ident).join(", ")}) values ${tuples.join(", ")}${returning}`, params];
      }
      case "update": {
        const sets = Object.entries(this.#values).map(([c, v]) => {
          params.push(v);
          return `${ident(c)} = $${params.length}`;
        });
        const returning = this.#returning ? " returning *" : "";
        return [`update ${t} set ${sets.join(", ")}${this.#where(params)}${returning}`, params];
      }
      case "delete": {
        const returning = this.#returning ? " returning *" : "";
        return [`delete from ${t}${this.#where(params)}${returning}`, params];
      }
      default:
        throw new Error(`unsupported verb: ${this.#verb}`);
    }
  }

  then(resolve, reject) {
    const [text, params] = this.#build();
    return this.#run(text, params).then(resolve, reject);
  }
}

class Client {
  #pool; #claims = null; #baseRole;

  constructor(pool, baseRole) { this.#pool = pool; this.#baseRole = baseRole; }

  // Mirrors supabase-js: a client built with the anon key acts as `anon` until someone
  // signs in, and as `authenticated` afterwards. Getting this wrong would silently give
  // every anonymous assertion an authenticated session -- the anon RLS cases would pass
  // while testing the wrong role entirely.
  get #role() { return this.#claims ? "authenticated" : this.#baseRole; }

  // Every statement runs inside the session's role and claims. Applied per query rather
  // than once at connect, because a client may sign in after it is created.
  async #run(conn, text, params) {
    try {
      await conn.query(`set local role ${this.#role}`);
      await conn.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [this.#claims ? JSON.stringify(this.#claims) : ""]
      );
      const { rows } = await conn.query(text, params);
      return toResult(rows);
    } catch (e) {
      return toError(e);
    }
  }

  // set local / set_config(..., true) are transaction-scoped, so each call is wrapped in
  // one. That was already true before this connection was pooled -- role and claims never
  // survived past one transaction -- so borrowing a fresh physical connection per
  // transaction changes nothing about what a test observes: no state a test depends on
  // ever lived on the connection between transactions, only within one. What it buys is
  // that a Client no longer PINS a connection for its whole lifetime (often the whole
  // suite, via `once(seedTwoVendors)`); many logical sessions can now share the same small
  // pool of physical connections, which is what keeps the suite well under Postgres's
  // max_connections as more seeded worlds are added.
  async #tx(fn) {
    const conn = await this.#pool.connect();
    try {
      await conn.query("begin");
      const result = await fn(conn);
      await conn.query(result.error ? "rollback" : "commit");
      return result;
    } catch (e) {
      await conn.query("rollback").catch(() => {});
      return toError(e);
    } finally {
      conn.release();
    }
  }

  from(table) {
    return new Query((text, params) => this.#tx(conn => this.#run(conn, text, params)), table);
  }

  async rpc(fn, args = {}) {
    const names = Object.keys(args);
    // A non-scalar argument goes over the wire as JSON, because that is what PostgREST
    // receives from supabase-js and hands to a json/jsonb parameter. node-pg would
    // otherwise render a JS array as a Postgres ARRAY literal ({"..."}), which no jsonb
    // parameter can accept -- a shim artefact that would make a call the real stack
    // performs fine look like a 22P02. Scalars (uuid, timestamptz, numbers, null) are
    // passed through untouched, as before.
    const encode = (v) =>
      v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
    const params = names.map(n => encode(args[n]));
    const call = names.length
      ? `select * from ${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")})`
      : `select * from ${ident(fn)}()`;
    const result = await this.#tx(conn => this.#run(conn, call, params));
    if (result.error) return result;
    // PostgREST unwraps a function's result to a single object when the function is
    // declared to return one row (not SETOF/TABLE); a set-returning function keeps the
    // array. proretset carries that distinction, so we look it up rather than guess from
    // the row count -- a purchase-only movement legitimately returns exactly one row of a
    // setof function too.
    if (!(await isSetReturning(this.#pool, fn))) {
      result.data = result.data.length ? result.data[0] : null;
    }
    return result;
  }

  get auth() {
    return {
      // Stands in for GoTrue: no password is verified and no JWT is minted. The session
      // is just the claims this connection will present. That is the honest limit of this
      // harness -- it tests what the DATABASE does with a caller's identity, not how that
      // identity is established.
      // No role/claims to set for either of these: both act as the pool's connecting
      // user (postgres), exactly as they did when this ran on a dedicated superuser
      // connection -- auth.users has no RLS to bypass and nothing here reads
      // request.jwt.claims. A single pooled query (acquire, run, release) is enough.
      signInWithPassword: async ({ email }) => {
        const { rows } = await this.#pool.query(
          `select id from auth.users where email = $1`, [email]
        );
        if (!rows.length) return { data: null, error: { message: `no such user: ${email}` } };
        this.#claims = { sub: rows[0].id, role: "authenticated" };
        return { data: { user: { id: rows[0].id } }, error: null };
      },
      signOut: async () => { this.#claims = null; return { error: null }; },
      admin: {
        createUser: async ({ email }) => {
          try {
            const { rows } = await this.#pool.query(
              `insert into auth.users (email) values ($1) returning id`, [email]
            );
            return { data: { user: { id: rows[0].id } }, error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
      },
    };
  }

  // No connection of its own to end any more -- see #tx. Kept as a no-op rather than
  // removed: closeAllClients() below still calls it, and nothing about a Client's own
  // lifetime is wrong to "close" here even though the physical work moved to the pool.
  async close() {}
}

// Cached per function name, per process: proretset never changes mid-run, and this is
// looked up on every rpc() call.
const SETOF_CACHE = new Map();
async function isSetReturning(pool, fn) {
  if (SETOF_CACHE.has(fn)) return SETOF_CACHE.get(fn);
  const { rows } = await pool.query(
    `select proretset from pg_proc where proname = $1 limit 1`, [fn]
  );
  const setof = rows.length ? rows[0].proretset : true;
  SETOF_CACHE.set(fn, setof);
  return setof;
}

// One pool per connection string (in practice always the suite's single DB_URL), shared
// by every Client rather than each Client holding its own permanent connection. A test
// "session" (role + JWT claims) only ever needs to be pinned to one physical connection
// for the span of a single transaction -- see #tx -- so many logical clients (every
// signed-in user across every seeded world in the whole suite) can share a small number
// of real connections instead of each permanently holding one open until bootstrap's
// once-per-run closeAllClients(). That pinning was the leak: a suite that seeds several
// worlds (each with three signed-in roles, times two vendors) could walk Postgres's
// default max_connections=100 down to nothing well before the run finished, and every
// world a later test file adds made it worse. `max: 10` is comfortably under 100 with
// room for the fixtures.mjs `sql()` pool and the handful of tests that intentionally open
// their own raw pg.Client for true concurrency (issue_token.test.mjs, claim_outbound.
// test.mjs) alongside it.
const POOLS = new Map();
function poolFor(connectionString) {
  let p = POOLS.get(connectionString);
  if (!p) {
    p = new pg.Pool({ connectionString, max: 10 });
    POOLS.set(connectionString, p);
  }
  return p;
}

// Starts anonymous, exactly as a client holding only the anon key does. signInWithPassword
// promotes it to `authenticated`.
export async function newClient(connectionString) {
  return new Client(poolFor(connectionString), "anon");
}

// service_role carries bypassrls, exactly as on Supabase. Used only to create users and
// seed -- never to make an assertion about what a policy allows.
export async function newServiceClient(connectionString) {
  return new Client(poolFor(connectionString), "service_role");
}

// Ends every shared pool -- called by resetStack() between runs so a reseeding suite does
// not accumulate connections across resets either.
export async function closeAllClients() {
  await Promise.all([...POOLS.values()].map(p => p.end()));
  POOLS.clear();
}
