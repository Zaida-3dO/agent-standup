// The shape the profile picker renders — MILESTONES.md #35, SCHEMA.md §8a
// ("people — profiles, not accounts"). Deliberately its own type rather
// than an import from `@/lib/service`: the front end reaches the service
// layer only through `GET /api/people`'s JSON, never its modules, so this
// mirrors that response shape instead of coupling to how the operation
// that produces it happens to be typed.
export interface Profile {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly colour: string | null;
}
