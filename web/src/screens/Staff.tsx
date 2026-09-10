import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Bill.tsx/Pending.tsx
// do. The screen is rendered directly (by tests, and by the router) without going
// through main.tsx.
import "../i18n";
import { createStaff, listStaff, updateStaff, removeStaff, type StaffRow } from "../admin";
import { canEditStaff, validateNewStaff, type NewStaffInput, type NewStaffField } from "../adminRules";
import { ROLES, type Role } from "../config";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";

const ROLE_KEY: Record<Role, string> = {
  admin: "staff.roleAdmin",
  recorder: "staff.roleRecorder",
  biller: "staff.roleBiller",
};

/**
 * The staff roster: §11b's admin-only view of app_users for this vendor.
 *
 * Adding someone LINKS an account that already exists; it does not invite one. Creating
 * the auth.users row needs auth.admin.createUser and so the service_role key, which
 * config.ts forbids in this bundle -- that is still the Edge Function slice. So the form
 * takes a user id the person reads off their own sign-up, which is exactly what
 * docs/runbook-first-admin.md previously had an admin do by hand in SQL. The screen says
 * that plainly rather than offering an invite button that would silently fail.
 *
 * canEditStaff blocks the signed-in admin from touching their own row: self-demotion or
 * self-removal is the one action that can lock a vendor out of its own tenant, since
 * users_admin_write requires current_user_role() = 'admin' and the repair is hand-written
 * SQL against production.
 */
export default function Staff() {
  const { t } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [editing, setEditing] = useState<{ id: string; name: string; role: Role } | null>(null);
  const [confirming, setConfirming] = useState<StaffRow | null>(null);
  const [adding, setAdding] = useState<NewStaffInput | null>(null);
  const [addErrors, setAddErrors] = useState<Partial<Record<NewStaffField, string>>>({});
  const [added, setAdded] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listStaff();
    setProblem(describeError(error));
    setRows(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const selfId = session.userId;
  const vendorId = session.vendorId;

  async function add() {
    if (!adding) return;
    setAdded(false);
    setProblem(null);
    const result = validateNewStaff(adding);
    if (!result.ok) { setAddErrors(result.errors); return; }
    setAddErrors({});
    setBusy(true);
    const { error } = await createStaff(vendorId, result.value);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    // Leave the form open and filled on failure. The common miss here is a mistyped or
    // already-linked id, and both are fixed by editing what is on screen -- clearing it
    // would make the admin fetch the id again to correct one character.
    if (described) return;
    setAdding(null);
    await load();
    setAdded(true);
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    const { error } = await updateStaff(editing.id, { name: editing.name, role: editing.role });
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setEditing(null);
    await load();
  }

  async function remove(row: StaffRow) {
    setBusy(true);
    const { error } = await removeStaff(row.id);
    setBusy(false);
    // Close the dialog whether or not the delete succeeded -- a 23503 (the person has
    // recorded or completed bills) is the common failure here, not an edge case, and
    // leaving the dialog open on it would look like the app had hung. load() runs before
    // the problem is set, because listStaff's own (null) error would otherwise clobber
    // the message we are about to show.
    setConfirming(null);
    await load();
    setProblem(describeError(error));
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("staff.title")}</h2>

      <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
        {t("staff.signUpFirst")}
      </p>

      {!adding && (
        <button
          data-testid="staff-add-open"
          onClick={() => {
            setAdded(false);
            setAddErrors({});
            setAdding({ id: "", name: "", role: "recorder" });
          }}
          className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px]"
        >
          {t("staff.add")}
        </button>
      )}

      {added && (
        <p data-testid="staff-added" className="text-sm text-green-700">{t("staff.added")}</p>
      )}

      {adding && (
        <form
          onSubmit={(e) => { e.preventDefault(); void add(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">{t("staff.addTitle")}</h3>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-id">
              {t("staff.userId")}
            </label>
            <input
              id="staff-add-id" data-testid="staff-add-id" value={adding.id}
              autoComplete="off" spellCheck={false}
              onChange={(e) => setAdding({ ...adding, id: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] font-mono text-sm"
            />
            {addErrors.id && (
              <p data-testid="staff-add-error-id" className="text-xs text-red-700 mt-1">
                {t(addErrors.id)}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-name">
              {t("staff.name")}
            </label>
            <input
              id="staff-add-name" data-testid="staff-add-name" value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
            {addErrors.name && (
              <p data-testid="staff-add-error-name" className="text-xs text-red-700 mt-1">
                {t(addErrors.name)}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-role">
              {t("staff.role")}
            </label>
            <select
              id="staff-add-role" data-testid="staff-add-role" value={adding.role}
              onChange={(e) => setAdding({ ...adding, role: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white"
            >
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="submit" data-testid="staff-add-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("staff.save")}
            </button>
            <button
              type="button" onClick={() => setAdding(null)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("staff.cancel")}
            </button>
          </div>
        </form>
      )}

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-name">
              {t("staff.name")}
            </label>
            <input
              id="staff-name" data-testid="staff-name" value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-role">
              {t("staff.role")}
            </label>
            <select
              id="staff-role" data-testid="staff-role" value={editing.role}
              onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white"
            >
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="submit" data-testid="staff-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("staff.save")}
            </button>
            <button
              type="button" onClick={() => setEditing(null)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("staff.cancel")}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("staff.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const editable = canEditStaff(selfId, row.id);
            return (
              <li
                key={row.id}
                className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">
                    {row.name}
                    {!editable && (
                      <span className="ml-2 text-xs text-slate-500">({t("staff.self")})</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">{t(ROLE_KEY[row.role])}</p>
                </div>
                {editable && (
                  <>
                    <button
                      data-testid={`staff-edit-${row.id}`}
                      onClick={() => setEditing({ id: row.id, name: row.name, role: row.role })}
                      className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                    >
                      {t("staff.edit")}
                    </button>
                    <button
                      data-testid={`staff-remove-${row.id}`}
                      onClick={() => setConfirming(row)}
                      className="border border-red-300 text-red-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                    >
                      {t("staff.remove")}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p data-testid="staff-self-locked" className="text-xs text-slate-500">
        {t("staff.selfLocked")}
      </p>

      {confirming && (
        <div
          role="dialog" aria-label={t("staff.confirmRemoveTitle")}
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl p-5 max-w-sm w-full space-y-3">
            <h3 className="font-semibold text-slate-800">{t("staff.confirmRemoveTitle")}</h3>
            <p data-testid="staff-remove-body" className="text-sm text-slate-600">
              {t("staff.confirmRemoveBody")}
            </p>
            <div className="flex gap-2">
              <button
                data-testid="staff-remove-confirm"
                onClick={() => void remove(confirming)} disabled={busy}
                className="rounded-lg px-4 py-2 text-sm bg-red-700 text-white min-h-[44px] disabled:opacity-50"
              >
                {t("staff.confirmRemoveAccept")}
              </button>
              <button
                onClick={() => setConfirming(null)}
                className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
              >
                {t("staff.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
