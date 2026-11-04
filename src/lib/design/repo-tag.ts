// When a repo tag adds nothing next to an area tag.
//
// Area and repo are both shown as small tags on a card. When they name the
// same thing ("web" and "web", or "Web Platform" and "web-platform") the
// second tag repeats the first, and the card reads "web web". Show one.
//
// Compared loosely, because an area is a free label that is normalised on
// the way in while a repo is an id: case, spaces, hyphens and underscores
// are ignored. Anything else that differs is kept, so two genuinely
// different values never collapse into one.
//
// Pure, no DOM.

/** The comparison form: lower case, with spaces, hyphens and underscores removed. */
function loose(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Whether `repo` is the same name as `area`, so only one tag should show. */
export function repoDuplicatesArea(area: string, repo: string | null | undefined): boolean {
  if (repo === null || repo === undefined || repo === "") return false;
  return loose(area) === loose(repo);
}

/** Whether a repo tag should render next to the area tag. */
export function showRepoTag(area: string, repo: string | null | undefined): repo is string {
  return repo !== null && repo !== undefined && repo !== "" && !repoDuplicatesArea(area, repo);
}
