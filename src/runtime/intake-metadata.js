// Local media must not wait forever for optional Curation/registry work.
// The deadline is an operation budget, not a delay before scanning. Every
// continuation must use current() before changing the active load/Profile.
export const INTAKE_METADATA_BUDGET_MS = 2000;

export async function runIntakeMetadata(operation, {
  isCurrent = () => true,
  onUnavailable = () => {},
  timeoutMs = INTAKE_METADATA_BUDGET_MS,
} = {}) {
  let live = true;
  let timer;
  const current = () => live && isCurrent();
  try {
    return await Promise.race([
      Promise.resolve().then(() => current() ? operation(current) : null),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Media metadata operation timed out")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (isCurrent()) onUnavailable(error);
    return null;
  } finally {
    live = false;
    clearTimeout(timer);
  }
}
