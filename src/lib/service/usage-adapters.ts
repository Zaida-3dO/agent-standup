// The usage-adapter registry — which vendors this build can read account
// usage from. See docs/plans/SCHEMA.md §15 ("`vendor` … Selects the usage
// adapter"), §17.7 and §23.2 ("`accounts.vendor` is checked against the
// registered adapter list on write; a vendor with no adapter is a setting
// nobody can act on.").
//
// **Distinct from `src/lib/adapters/registry.ts`.** That module registers
// *transport* adapters — http, mcp_http, mcp_stdio, cli: the doors into the
// service layer. This registers *usage* adapters — one per vendor, the
// thing that would eventually read `accounts.usage5h`/`usage_weekly` off a
// vendor's own API. No usage-polling adapter is implemented yet (no
// MILESTONES.md row builds one), so this is deliberately just the closed
// list of vendor identifiers `accounts.vendor` is allowed to name — the
// list a future usage adapter would be registered under — kept in one place
// now so the column has something real to be checked against rather than
// accepting free text until that adapter exists. Adding a vendor here is a
// deliberate, reviewed act, the same posture MILESTONES.md #91 gives
// `repos` (SCHEMA.md §23.1): a wrong or unrecognised vendor selects no
// usage adapter at all, silently, so it is refused rather than stored.
export const REGISTERED_VENDORS = ["anthropic"] as const;

export type VendorName = (typeof REGISTERED_VENDORS)[number];

/** Whether a string names a vendor this build has a usage adapter registered for. */
export function isRegisteredVendor(value: string): value is VendorName {
  return (REGISTERED_VENDORS as readonly string[]).includes(value);
}
