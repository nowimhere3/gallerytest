import { classifySelection } from "../src/intake/classify-selection.js";
import { extractRemoteUrls } from "../src/providers/remote-url-parser.js";

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

console.log(`selection classifier: ${assertions} assertions passed`);
