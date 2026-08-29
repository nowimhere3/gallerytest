This PR adds a regression test to cover an edge case where a `LOCAL_SEED_T` (seed-floor) alias wins out, but the primary T0 base fact is entirely missing. This ensures the system safely reports what it finds without failing due to an undefined base fact.

- The reachable production scenario protected is when `applySeedFloorPolicy` executes with an alias containing a valid seed fact, but the T0 key being checked has no associated fact at all.
- The existing seed-floor test did not cover this because it assumed a real mutation (or at least a status quo fact) would be present on the T0 key.
- The exact test file changed is `tools/test-media-projection.mjs`.
- The test was verified by running `node tools/test-media-projection.mjs`, producing a clean run with 100 assertions passed.
- We also confirm that the animation-port investigation was verified as a no-op (the target features were already in `SandboxSyncV3`) and has contributed zero files to this PR.
