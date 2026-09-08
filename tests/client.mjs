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
  #conn; #claims = null; #baseRole;

  constructor(conn, baseRole) { this.#conn = conn; this.#baseRole = baseRole; }

  // Mirrors supabase-js: a client built with the anon key acts as `anon` until someone
  // signs in, and as `authenticated` afterwards. Getting this wrong would silently give
  // every anonymous assertion an authenticated session -- the anon RLS cases would pass
  // while testing the wrong role entirely.
  get #role() { return this.#claims ? "authenticated" : this.#baseRole; }

  // Every statement runs inside the session's role and claims. Applied per query rather
  // than once at connect, because a client may sign in after it is created.
  async #run(text, params) {
    try {
      await this.#conn.query(`set local role ${this.#role}`);
      await this.#conn.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [this.#claims ? JSON.stringify(this.#claims) : ""]
      );
      const { rows } = await this.#conn.query(text, params);
      return toResult(rows);
    } catch (e) {
      return toError(e);
    }
  }

  // set local / set_config(..., true) are transaction-scoped, so each call is wrapped in
  // one. Without the transaction the role would leak into the next statement, or reset
  // between them, depending on pooling -- both silently wrong.
  async #tx(fn) {
    await this.#conn.query("begin");
    try {
      const result = await fn();
      await this.#conn.query(result.error ? "rollback" : "commit");
      return result;
    } catch (e) {
      await this.#conn.query("rollback").catch(() => {});
      return toError(e);
    }
  }

  from(table) {
    return new Query((text, params) => this.#tx(() => this.#run(text, params)), table);
  }

  async rpc(fn, args = {}) {
    const names = Object.keys(args);
    const params = names.map(n => args[n]);
    const call = names.length
      ? `select * from ${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")})`
      : `select * from ${ident(fn)}()`;
    return this.#tx(() => this.#run(call, params));
  }

  get auth() {
    return {
      // Stands in for GoTrue: no password is verified and no JWT is minted. The session
      // is just the claims this connection will present. That is the honest limit of this
      // harness -- it tests what the DATABASE does with a caller's identity, not how that
      // identity is established.
      signInWithPassword: async ({ email }) => {
        const { rows } = await this.#conn.query(
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
            const { rows } = await this.#conn.query(
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

  async close() { await this.#conn.end().catch(() => {}); }
}

const open = async (connectionString, role) => {
  const conn = new pg.Client({ connectionString });
  await conn.connect();
  return new Client(conn, role);
};

// Every client opened here, so bootstrap can close them between runs rather than leaking
// connections across a suite that reseeds.
const OPEN = [];

// Starts anonymous, exactly as a client holding only the anon key does. signInWithPassword
// promotes it to `authenticated`.
export async function newClient(connectionString) {
  const c = await open(connectionString, "anon");
  OPEN.push(c);
  return c;
}

// service_role carries bypassrls, exactly as on Supabase. Used only to create users and
// seed -- never to make an assertion about what a policy allows.
export async function newServiceClient(connectionString) {
  const c = await open(connectionString, "service_role");
  OPEN.push(c);
  return c;
}

export async function closeAllClients() {
  await Promise.all(OPEN.splice(0).map(c => c.close()));
}
