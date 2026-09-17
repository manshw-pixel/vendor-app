-- The printed receipt's shop header (Slice A).
--
-- vendors has carried only the shop name and the loyalty config. A slip that says who
-- the shop is needs an address and a phone number, and neither existed anywhere.
--
-- Both NULLABLE, deliberately. Every existing vendor row has neither, and a NOT NULL
-- column would have to invent a value for them. The receipt omits a line that is blank
-- rather than printing an empty one, so null is a renderable state, not a missing one.
alter table vendors
  add column address text,
  add column phone   text;

comment on column vendors.address is
  'Shop address for the printed receipt header. Nullable: the slip omits the line when '
  'blank. Free text, not parsed -- it is printed as typed, wrapped to 58mm.';

comment on column vendors.phone is
  'Shop phone for the printed receipt header. Nullable, free text, printed as typed. '
  'Not the WhatsApp sender number, which is a Gupshup app secret and not per-vendor.';

-- No new policy. vendors_read (select, any authenticated member of the vendor) and
-- vendors_admin_update (update, admin only) in 0002_rls.sql already cover the whole row,
-- so these two columns inherit exactly the boundary the loyalty config has had since 0001.
