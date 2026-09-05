import { extractRemoteUrls } from "../providers/remote-url-parser.js";
import { getExtension, isSupportedFile } from "../providers/local-file-input-provider.js";

function isTopLevelFolderEntry(file) {
  const relativePath = file.webkitRelativePath || "";
  return !relativePath || relativePath.split(/[\\/]/).filter(Boolean).length <= 2;
}

export async function collectSelectionEvidence(fileList, { shape } = {}) {
  const files = Array.from(fileList || []);
  const entries = [];

  for (const file of files) {
    const isSupportedMedia = isSupportedFile(file);
    const isTextCandidate = getExtension(file) === "txt"
      && (shape !== "folder" || isTopLevelFolderEntry(file));
    let floppyText = null;
    let qualifiesAsFloppy = false;

    if (isTextCandidate) {
      const text = await file.text();
      if (extractRemoteUrls(text).urls.length > 0) {
        qualifiesAsFloppy = true;
        floppyText = text;
      }
    }

    entries.push({
      name: file.name || "",
      relativePath: file.webkitRelativePath || file.name || "",
      isSupportedMedia,
      isTextCandidate,
      qualifiesAsFloppy,
      floppyText,
    });
  }

  return { shape, entries };
}

export function combineQualifyingFloppyTexts(evidence) {
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

  return (evidence?.entries || [])
    .filter((entry) => entry.qualifiesAsFloppy && typeof entry.floppyText === "string")
    .sort((left, right) => {
      const folded = compareText(left.name.toLowerCase(), right.name.toLowerCase());
      if (folded) return folded;
      const exact = compareText(left.name, right.name);
      if (exact) return exact;
      return compareText(left.relativePath, right.relativePath);
    })
    .map((entry) => entry.floppyText)
    .join("\n");
}
