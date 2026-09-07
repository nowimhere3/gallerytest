import { classifySelection } from "./classify-selection.js";
import {
  collectSelectionEvidence,
  combineQualifyingFloppyTexts,
} from "./collect-selection-evidence.js";

export async function collectFolderEvidence(directoryHandle) {
  const files = [];

  async function walk(handle, relativePrefix = "") {
    for await (const entry of handle.values()) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        await walk(entry, relativePath);
        continue;
      }
      if (entry.kind !== "file") continue;

      const file = await entry.getFile();
      files.push({
        name: file.name,
        type: file.type,
        webkitRelativePath: `${directoryHandle.name}/${relativePath}`,
        text: () => file.text(),
      });
    }
  }

  await walk(directoryHandle);
  return collectSelectionEvidence(files, { shape: "folder" });
}

export async function readRememberedFolder(directoryHandle) {
  const evidence = await collectFolderEvidence(directoryHandle);
  return {
    evidence,
    selectionKind: classifySelection(evidence),
    combinedText: combineQualifyingFloppyTexts(evidence),
  };
}

export function getRememberedCassetteOwner(record) {
  return record?.sourceKind === "cassette-folder" ? "folder" : "file";
}
