from __future__ import annotations

import threading
import time
import unittest

from src.cancellable_lock import acquire_lock_cancellable


class CancellableLockTests(unittest.TestCase):
    def test_cancellation_interrupts_wait_for_busy_lock(self) -> None:
        lock = threading.Lock()
        lock.acquire()
        cancelled = threading.Event()
        result: list[bool] = []

        worker = threading.Thread(
            target=lambda: result.append(
                acquire_lock_cancellable(lock, cancelled.is_set, poll_interval=0.01)
            )
        )
        worker.start()
        time.sleep(0.05)
        cancelled.set()
        worker.join(timeout=0.5)

        self.assertFalse(worker.is_alive(), "lock wait should stop promptly after cancellation")
        self.assertEqual(result, [False])
        lock.release()

    def test_acquires_available_lock(self) -> None:
        lock = threading.Lock()
        self.assertTrue(acquire_lock_cancellable(lock, lambda: False, poll_interval=0.01))
        self.assertFalse(lock.acquire(blocking=False), "successful acquire must hold the lock")
        lock.release()

    def test_releases_lock_if_cancelled_during_acquire(self) -> None:
        lock = threading.Lock()
        checks = 0

        def cancel_after_acquire() -> bool:
            nonlocal checks
            checks += 1
            return checks >= 2

        self.assertFalse(acquire_lock_cancellable(lock, cancel_after_acquire, poll_interval=0.01))
        self.assertTrue(lock.acquire(blocking=False), "cancelled acquire must release the lock")
        lock.release()


if __name__ == "__main__":
    unittest.main()
