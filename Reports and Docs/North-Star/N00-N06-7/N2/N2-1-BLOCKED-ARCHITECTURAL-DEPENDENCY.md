# North Star N2 — Blocked: Architectural Dependency

**Recorded:** 2026-08-27 11:02:39 MDT (America/Edmonton, UTC-06:00)
**Status:** BLOCKED
**Scope:** N2 — Device-Aware Human Questions

N2 cannot be implemented safely with the architecture and evidence currently available:

- No safe current-media candidate signal exists.
- Shared catalog data contains a collection name, `sourceDeviceId`, `lastLoadedAt`, and a Curation association, but nothing links the **current unassigned folder** to a specific peer collection.
- `resolveDeviceName(deviceId)` can phrase a known candidate; it cannot create or identify one.
- Peer or catalog presence alone is context, not identity evidence.
- Folder, library, and device names are presentation and cannot prove identity.
- Current MEDIA-ID evidence is device-local and therefore cannot establish cross-device collection identity.
- The portable, content-corroborated structural evidence needed to propose a candidate safely belongs to N5.

Implementing N2 now would either violate the North Star by asking a plumbing question without a safely evidenced candidate, or improperly pull N5 SyncV3/fact-model changes into N2.

Corrected sequence:

```text
N1 complete → N2 blocked → N3 → N4 → N5 → resume N2
```

This architectural blocker is the N2 report event. No production code or tests were changed.
