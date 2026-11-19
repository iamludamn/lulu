import { artifactName } from "../protocol/send.js";

export const SPACE_DIR = "spaces/";

const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const spacePage = (id: string): string => `${SPACE_DIR}${id}/index.html`;

export function assetRefProblem(ref: string): string | undefined {
  const name = artifactName(ref);
  if (name === undefined || !name.startsWith(SPACE_DIR)) return undefined;
  return "Space files are reserved for existing Spaces and cannot be offered as Assets. Nothing was sent.";
}

export function spaceRefProblem(id: string, src: string): string | undefined {
  if (!WIDGET_ID.test(id)) return `A space's widget id must be lowercase letters, digits and hyphens, at most 64 characters, such as nba-schedule; "${id}" is not. Nothing was changed.`;
  if (artifactName(src) === spacePage(id)) return undefined;
  return `A space's page must be saved as ${spacePage(id)} (the folder name is the widget id) and src must be its artifact:// reference; got ${src}. Save the page under that name with the artifact tools and use the ref they return. Nothing was changed.`;
}

export function spacePreviewProblem(id: string, ref: string | undefined): string | undefined {
  if (ref === undefined) return "A space requires a separate cover. Save spaces/" + id + "/cover.html and include its versioned artifact reference as preview. Nothing was changed.";
  if (artifactName(ref) === `${SPACE_DIR}${id}/cover.html`) return undefined;
  return `A space cover must be saved as ${SPACE_DIR}${id}/cover.html and preview must be its versioned artifact reference. Nothing was changed.`;
}
