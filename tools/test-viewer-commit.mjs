import { shouldCommitPreparedViewer } from "../src/runtime/viewer-commit.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

// Two distinct item objects. Identity is what the predicate compares, so these
// deliberately look alike — two loads of the same URL are NOT the same item.
const itemA = { id: "remote-1", url: "https://cdn.example.com/a.jpg" };
const itemB = { id: "remote-2", url: "https://cdn.example.com/b.jpg" };
const itemBTwin = { id: "remote-2", url: "https://cdn.example.com/b.jpg" };

function scenario(overrides = {}) {
  return {
    preparedToken: 7,
    currentToken: 7,
    preparedLoadGeneration: 3,
    currentLoadGeneration: 3,
    preparedGalleryGeneration: 11,
    currentGalleryGeneration: 11,
    preparedItem: itemB,
    currentViewerItem: itemB,
    ...overrides,
  };
}

// ---- The ordinary case ----------------------------------------------------

assert(shouldCommitPreparedViewer(scenario()) === true, "all four facts match: commits");

// ---- Each guard is independently load-bearing -----------------------------

assert(
  shouldCommitPreparedViewer(scenario({ currentToken: 8 })) === false,
  "a superseded token alone rejects"
);
assert(
  shouldCommitPreparedViewer(scenario({ currentLoadGeneration: 4 })) === false,
  "a newer load generation alone rejects"
);
assert(
  shouldCommitPreparedViewer(scenario({ currentGalleryGeneration: 12 })) === false,
  "a newer gallery generation alone rejects"
);
assert(
  shouldCommitPreparedViewer(scenario({ currentViewerItem: itemA })) === false,
  "a different current item alone rejects"
);
assert(
  shouldCommitPreparedViewer(scenario({ currentViewerItem: itemBTwin })) === false,
  "identity, not equality: a look-alike item rejects"
);

// ---- Nothing is not something ---------------------------------------------

assert(
  shouldCommitPreparedViewer(scenario({ preparedItem: null, currentViewerItem: null })) === false,
  "a preparation for no item never commits, even against a null current item"
);
assert(shouldCommitPreparedViewer() === false, "an empty call rejects rather than throwing");

// ---- The council's B/C scenario, verbatim ---------------------------------
//
//   A visible -> Next (B begins preparing) -> Next again (C begins preparing)
//   -> B finishes LAST.  Required: A ... then C.  Forbidden: B appears.

const world = { token: 0, loadGeneration: 3, galleryGeneration: 11, currentViewerItem: itemA };

// Next -> B claims the viewer.
const preparedB = {
  token: ++world.token,
  loadGeneration: world.loadGeneration,
  galleryGeneration: world.galleryGeneration,
  item: itemB,
};
world.currentViewerItem = itemB;

// Next again, before B settled -> C supersedes it.
const itemC = { id: "remote-3", url: "https://cdn.example.com/c.jpg" };
const preparedC = {
  token: ++world.token,
  loadGeneration: world.loadGeneration,
  galleryGeneration: world.galleryGeneration,
  item: itemC,
};
world.currentViewerItem = itemC;

function evaluate(prepared) {
  return shouldCommitPreparedViewer({
    preparedToken: prepared.token,
    currentToken: world.token,
    preparedLoadGeneration: prepared.loadGeneration,
    currentLoadGeneration: world.loadGeneration,
    preparedGalleryGeneration: prepared.galleryGeneration,
    currentGalleryGeneration: world.galleryGeneration,
    preparedItem: prepared.item,
    currentViewerItem: world.currentViewerItem,
  });
}

assert(evaluate(preparedC) === true, "C is current and commits");
assert(evaluate(preparedB) === false, "B finishing later must never commit");

// Order of completion must not change either verdict.
assert(evaluate(preparedB) === false, "out-of-order: B still rejects after C already committed");
assert(evaluate(preparedC) === true, "out-of-order: C still commits regardless of settle order");

// ---- Two preparations for the SAME item -----------------------------------

const firstForC = { ...preparedC };
const secondForC = { ...preparedC, token: ++world.token };
assert(evaluate(secondForC) === true, "the newer preparation for the same item commits");
assert(evaluate(firstForC) === false, "the older preparation for the same item does not");

// ---- Source switching: the Phase 1 no-residue guarantee, frozen -----------
//
// A prepared image from a retired cassette or folder must never appear after a
// switch, even when nothing else about it looks stale.

world.loadGeneration += 1;
assert(
  evaluate(secondForC) === false,
  "a prepared image cannot survive a source switch even with a matching token and item"
);

// A filter / View / Type / Tag change bumps the gallery generation instead.
world.loadGeneration -= 1;
world.galleryGeneration += 1;
assert(
  evaluate(secondForC) === false,
  "a prepared image cannot survive a visible-list change even with a matching token and item"
);

console.log(`viewer commit: ${assertions} assertions passed`);
