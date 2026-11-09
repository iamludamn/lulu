import { artifactName } from "../protocol/send.js";

export const SPACE_DIR = "spaces/";

const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const spacePage = (id: string): string => `${SPACE_DIR}${id}/index.html`;

export const PAGE_KINDS = [
  "An .html page is one of two things.",
  "An html asset is a finished deliverable: everything it shows is baked in when you write it, it never loads anything from the network, and it forgets everything when closed. Offer it with a send_to_user kind asset card, and the user keeps it in their assets.",
  "A space is a small app the user keeps on their panel and comes back to: it fetches live data from public APIs when opened, or remembers what the user does, or both. Offer it with a send_to_user kind panel card whose body is { kind: space, src, refresh }; it lives at `spaces/<widget id>/index.html` and nowhere else.",
  "Decide with one question: will the user come back expecting the page to be newer than when you made it, or to find what they did last time? Yes means space, no means html asset.",
  "Data wanted as of now, such as today's schedule or a comparison, is an html asset with the data baked in. When unsure, build an html asset; it can become a space later.",
].join(" ");

export function assetRefProblem(ref: string): string | undefined {
  const name = artifactName(ref);
  if (name === undefined || !name.startsWith(SPACE_DIR)) return undefined;
  return `${name} is under ${SPACE_DIR}, so it is a space, and a space is never offered as an asset. Send it as a kind panel card whose body is { kind: space, src: "${ref}" } and a widget id of lowercase letters, digits and hyphens. Nothing was sent.`;
}

export function spaceRefProblem(id: string, src: string): string | undefined {
  if (!WIDGET_ID.test(id)) return `A space's widget id must be lowercase letters, digits and hyphens, at most 64 characters, such as nba-schedule; "${id}" is not. Nothing was changed.`;
  if (artifactName(src) === spacePage(id)) return undefined;
  return `A space's page must be saved as ${spacePage(id)} (the folder name is the widget id) and src must be its artifact:// reference; got ${src}. Save the page under that name with the artifact tools and use the ref they return. Nothing was changed.`;
}
