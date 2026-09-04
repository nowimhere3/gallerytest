import { classifySelection } from "../src/intake/classify-selection.js";
import {
  collectSelectionEvidence,
  combineQualifyingFloppyTexts,
} from "../src/intake/collect-selection-evidence.js";
import { extractRemoteUrls } from "../src/providers/remote-url-parser.js";
import { RemoteUrlProvider } from "../src/providers/remote-url-provider.js";

let assertions = 0;
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  assertions += 1;
}

const media = (name) => ({ name, isSupportedMedia: true, isTextCandidate: false, qualifiesAsFloppy: false });
const floppy = (name) => ({ name, isSupportedMedia: false, isTextCandidate: true, qualifiesAsFloppy: true });
const junk = (name) => ({ name, isSupportedMedia: false, isTextCandidate: false, qualifiesAsFloppy: false });

const classificationCases = [
  ["one supported media file", { shape: "files", entries: [media("photo.jpg")] }, "local-files"],
  ["multiple supported media files", { shape: "files", entries: [media("photo.jpg"), media("video.mp4")] }, "local-files"],
  ["one qualifying Floppy entry", { shape: "files", entries: [floppy("Master.txt")] }, "floppy-file"],
  ["two qualifying Floppy entries", { shape: "files", entries: [floppy("One.txt"), floppy("Two.txt")] }, "unsupported"],
  ["media and Floppy files", { shape: "files", entries: [media("photo.jpg"), floppy("Master.txt")] }, "mixed"],
  ["empty files selection", { shape: "files", entries: [] }, "unsupported"],
  ["folder containing supported media", { shape: "folder", entries: [media("photo.jpg")] }, "local-folder"],
  ["folder containing multiple Floppies", { shape: "folder", entries: [floppy("One.txt"), floppy("Two.txt")] }, "floppy-folder"],
  ["folder containing media and Floppy", { shape: "folder", entries: [media("photo.jpg"), floppy("Master.txt")] }, "mixed"],
  ["folder containing only unsupported entries", { shape: "folder", entries: [junk("Thumbs.db"), junk("notes.docx")] }, "unsupported"],
  ["folder containing media and junk", { shape: "folder", entries: [media("photo.jpg"), media("video.mp4"), junk("Thumbs.db"), junk(".DS_Store")] }, "local-folder"],
  ["folder containing Floppy and junk", { shape: "folder", entries: [floppy("Master.txt"), junk("Thumbs.db"), junk("notes.docx")] }, "floppy-folder"],
];

for (const [label, evidence, expected] of classificationCases) {
  assertEqual(classifySelection(evidence), expected, label);
}

for (const [label, evidence] of [
  ["missing evidence", undefined],
  ["unknown shape", { shape: "archive", entries: [media("photo.jpg")] }],
  ["malformed entries", { shape: "files", entries: null }],
]) {
  assertEqual(classifySelection(evidence), "unsupported", label);
}

const qualificationCases = [
  ["valid URL list qualifies", "https://cdn.example.com/photo.jpg\nhttps://cdn.example.com/video.mp4", true],
  ["partially valid list qualifies", "not a URL\nhttps://cdn.example.com/photo.jpg", true],
  ["empty text does not qualify", "", false],
  ["comments only do not qualify", "# gallery links\n// none yet", false],
  ["invalid URLs only do not qualify", "ftp://cdn.example.com/photo.jpg\njavascript:alert(1)", false],
  ["ordinary prose does not qualify", "This is an ordinary note without media links.", false],
];

for (const [label, text, expected] of qualificationCases) {
  assertEqual(extractRemoteUrls(text).urls.length > 0, expected, label);
}

const fakeFile = (name, { type = "", text = "", path = "" } = {}) => ({
  name,
  type,
  webkitRelativePath: path,
  text: async () => text,
});

const mediaFilesEvidence = await collectSelectionEvidence([
  fakeFile("a.jpg", { type: "image/jpeg" }),
  fakeFile("b.mp4", { type: "video/mp4" }),
], { shape: "files" });
assertEqual(classifySelection(mediaFilesEvidence), "local-files", "adapter classifies ordinary media files");

const livePickerFiles = [fakeFile("snapshot.jpg", { type: "image/jpeg" })];
const pickerSnapshot = Array.from(livePickerFiles);
livePickerFiles.length = 0;
const snapshotEvidence = await collectSelectionEvidence(pickerSnapshot, { shape: "files" });
assertEqual(classifySelection(snapshotEvidence), "local-files", "clearing picker after snapshot preserves async evidence");

const floppyFileEvidence = await collectSelectionEvidence([
  fakeFile("Master.txt", { text: "https://cdn.example.com/standalone.jpg" }),
], { shape: "files" });
assertEqual(classifySelection(floppyFileEvidence), "floppy-file", "adapter classifies a standalone Floppy file");

const mediaFolderEvidence = await collectSelectionEvidence([
  fakeFile("a.jpg", { type: "image/jpeg", path: "Photos/a.jpg" }),
  fakeFile("Thumbs.db", { path: "Photos/Thumbs.db" }),
], { shape: "folder" });
assertEqual(classifySelection(mediaFolderEvidence), "local-folder", "adapter classifies media folder despite junk");

const floppyFolderEvidence = await collectSelectionEvidence([
  fakeFile("b.txt", { text: "https://cdn.example.com/shared.jpg\nhttps://cdn.example.com/b.mp4", path: "Floppies/b.txt" }),
  fakeFile("A.txt", { text: "ordinary prose\nhttps://cdn.example.com/shared.jpg\nhttps://cdn.example.com/a.png", path: "Floppies/A.txt" }),
  fakeFile("notes.docx", { path: "Floppies/notes.docx" }),
  fakeFile("nested.txt", { text: "https://cdn.example.com/nested.jpg", path: "Floppies/sub/nested.txt" }),
], { shape: "folder" });
assertEqual(classifySelection(floppyFolderEvidence), "floppy-folder", "adapter classifies qualifying Floppy folder");
assertEqual(
  floppyFolderEvidence.entries.find((entry) => entry.name === "nested.txt").qualifiesAsFloppy,
  false,
  "nested text is excluded from top-level Floppy semantics"
);
const combinedText = combineQualifyingFloppyTexts(floppyFolderEvidence);
assertEqual(combinedText.startsWith("ordinary prose"), true, "Floppy texts use case-insensitive filename order");
const combinedUrls = extractRemoteUrls(combinedText).urls;
assertEqual(combinedUrls.length, 3, "combined text inherits parser duplicate URL dedupe");
const combinedItems = (await new RemoteUrlProvider().loadFromUrls(combinedUrls)).items;
assertEqual(new Set(combinedItems.map((item) => item.id)).size, 3, "combined session provider ids are unique");
assertEqual(new Set(combinedItems.map((item) => item.relativePath)).size, 3, "combined session remote paths are unique");

const mixedFolderEvidence = await collectSelectionEvidence([
  fakeFile("photo.jpg", { type: "image/jpeg", path: "Mixed/photo.jpg" }),
  fakeFile("Master.txt", { text: "invalid prose\nhttps://cdn.example.com/photo.jpg", path: "Mixed/Master.txt" }),
], { shape: "folder" });
assertEqual(classifySelection(mixedFolderEvidence), "mixed", "adapter rejects media and Floppy folder");

const proseFolderEvidence = await collectSelectionEvidence([
  fakeFile("notes.txt", { text: "ordinary prose", path: "Notes/notes.txt" }),
  fakeFile(".DS_Store", { path: "Notes/.DS_Store" }),
], { shape: "folder" });
assertEqual(classifySelection(proseFolderEvidence), "unsupported", "ordinary prose and junk folder is unsupported");

console.log(`selection classifier: ${assertions} assertions passed`);
