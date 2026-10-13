from __future__ import annotations

from typing import Any, Callable


def acquire_lock_cancellable(
    lock: Any,
    cancel_check: Callable[[], bool],
    poll_interval: float = 0.05,
) -> bool:
    """Wait for a lock without preventing a queued job from being cancelled."""
    while True:
        if cancel_check():
            return False
        if lock.acquire(timeout=poll_interval):
            if cancel_check():
                lock.release()
                return False
            return True
