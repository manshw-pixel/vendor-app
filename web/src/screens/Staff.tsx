import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Bill.tsx/Pending.tsx
// do. The screen is rendered directly (by tests, and by the router) without going
// through main.tsx.
import "../i18n";
import { listStaff, updateStaff, type StaffRow } from "../admin";
import { createUserAccount, deleteUserAccount } from "../adminApi";
import { canEditStaff, validateNewStaff, type NewStaffInput, type NewStaffField } from "../adminRules";
import { ROLES, type Role } from "../config";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { EmptyState } from "../ui/EmptyState";
import { Dialog } from "../ui/Dialog";

const ROLE_KEY: Record<Role, string> = {
  admin: "staff.roleAdmin",
  recorder: "staff.roleRecorder",
  biller: "staff.roleBiller",
};

/**
 * The staff roster: §11b's admin-only view of app_users for this vendor.
 *
 * Adding someone CREATES the account: the admin types an email, a first password and a
 * name, and the admin-create-user Edge Function calls auth.admin.createUser with the
 * service_role key the SPA is never allowed to hold (config.ts forbids it in this
 * bundle). No vendor id is sent -- the function reads it from app_users under the
 * caller's own JWT, which is what stops an admin creating staff in someone else's shop.
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
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await listStaff();
    setProblem(describeError(error));
    setRows(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const selfId = session.userId;

  async function add() {
    if (!adding) return;
    setAdded(false);
    setProblem(null);
    const result = validateNewStaff(adding);
    if (!result.ok) { setAddErrors(result.errors); return; }
    setAddErrors({});
    setBusy(true);
    const { error } = await createUserAccount(result.value);
    setBusy(false);
    setProblem(error);
    // Leave the form filled on failure. "That address already has an account" is the
    // common miss, and it is fixed by editing what is on screen.
    if (error) return;
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
    const { error } = await deleteUserAccount(row.id);
    setBusy(false);
    // Close the dialog whether or not it succeeded -- a 409 (the person has recorded or
    // completed bills) is the common failure here, not an edge case, and leaving the
    // dialog open on it would look like the app had hung. load() runs before the problem
    // is set, because listStaff's own (null) error would otherwise clobber the message.
    setConfirming(null);
    await load();
    setProblem(error);
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("staff.title")}</h2>

      <Banner tone="info">{t("staff.adminCreates")}</Banner>

      {!adding && (
        <Button
          data-testid="staff-add-open"
          onClick={() => {
            setAdded(false);
            setAddErrors({});
            setAdding({ email: "", password: "", name: "", role: "recorder" });
          }}
        >
          {t("staff.add")}
        </Button>
      )}

      {added && (
        <Banner tone="success"><span data-testid="staff-added">{t("staff.added")}</span></Banner>
      )}

      {adding && (
        <form
          onSubmit={(e) => { e.preventDefault(); void add(); }}
          // noValidate: the email input's native type=email check would otherwise block
          // the submit event entirely on a bad address, so validateNewStaff's own message
          // (and its test) would never run.
          noValidate
          className="border border-slate-200 rounded-xl bg-surface p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">{t("staff.addTitle")}</h3>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-email">
              {t("staff.email")}
            </label>
            <input
              id="staff-add-email" data-testid="staff-add-email" type="email" value={adding.email}
              autoComplete="off" spellCheck={false}
              onChange={(e) => setAdding({ ...adding, email: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
            {addErrors.email && (
              <p data-testid="staff-add-error-email" className="text-xs text-red-700 mt-1">
                {t(addErrors.email)}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-password">
              {t("staff.password")}
            </label>
            {/* type=password even though the admin is typing it themselves: a shop counter
                is not a private place, and this is filled while someone reads it out. */}
            <input
              id="staff-add-password" data-testid="staff-add-password" type="password"
              value={adding.password} autoComplete="new-password"
              onChange={(e) => setAdding({ ...adding, password: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
            <p className="text-xs text-slate-500 mt-1">{t("staff.passwordHint")}</p>
            {addErrors.password && (
              <p data-testid="staff-add-error-password" className="text-xs text-red-700 mt-1">
                {t(addErrors.password)}
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
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-surface"
            >
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" data-testid="staff-add-save" disabled={busy}>
              {t("staff.save")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAdding(null)}>
              {t("staff.cancel")}
            </Button>
          </div>
        </form>
      )}

      {problem && (
        <Banner tone="error">{t(problem.key)}</Banner>
      )}

      {editing && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="border border-slate-200 rounded-xl bg-surface p-4 space-y-3"
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
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-surface"
            >
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" data-testid="staff-save" disabled={busy}>
              {t("staff.save")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              {t("staff.cancel")}
            </Button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <EmptyState>{t("staff.empty")}</EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const editable = canEditStaff(selfId, row.id);
            return (
              <li
                key={row.id}
                className="bg-surface border border-slate-200 rounded-xl p-3 flex items-center gap-3"
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
                    <Button
                      variant="secondary"
                      data-testid={`staff-edit-${row.id}`}
                      onClick={() => setEditing({ id: row.id, name: row.name, role: row.role })}
                    >
                      {t("staff.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid={`staff-remove-${row.id}`}
                      onClick={() => setConfirming(row)}
                      className="border-red-300 text-red-700"
                    >
                      {t("staff.remove")}
                    </Button>
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
        <Dialog
          label={t("staff.confirmRemoveTitle")}
          onClose={() => { if (!busy) setConfirming(null); }}
          initialFocusRef={cancelRemoveRef}
        >
          <h3 className="font-semibold text-slate-800">{t("staff.confirmRemoveTitle")}</h3>
          <p data-testid="staff-remove-body" className="text-sm text-slate-600">
            {t("staff.confirmRemoveBody")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              data-testid="staff-remove-confirm"
              onClick={() => void remove(confirming)} disabled={busy}
            >
              {t("staff.confirmRemoveAccept")}
            </Button>
            <Button
              variant="secondary"
              ref={cancelRemoveRef}
              onClick={() => setConfirming(null)}
            >
              {t("staff.cancel")}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
