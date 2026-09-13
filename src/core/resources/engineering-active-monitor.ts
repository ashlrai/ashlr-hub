/** Leave an event-loop gap after each synchronous ownership check. */
export function startEngineeringActiveMonitor(assertActive: () => void, onFailure: () => void): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    closed = true;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };
  const check = () => {
    timer = undefined;
    if (closed) return;
    try { assertActive(); }
    catch { stop(); onFailure(); return; }
    // A check can be more expensive than the polling delay (notably native ACL
    // inspection). Do not enqueue an already-overdue check after it completes.
    // Cancellation inside the check must also prevent rearming.
    if (!closed) timer = setTimeout(check, 25);
  };
  timer = setTimeout(check, 25);
  return stop;
}
