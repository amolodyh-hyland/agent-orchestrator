import fcntl
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("restore", Path(__file__).with_name("rollback-restore.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ao-restore-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.backup, self.target, self.data = [self.root / name for name in ("backup", "Applications/AO.app", "data")]
        self.backup.mkdir()
        self.data.mkdir()
        self.app(self.target, "new")
        self.app(self.backup / "previous.app", "old")
        (self.backup / "BACKUP_COMPLETE").write_text("app_backup=previous.app\napp_version=old\nschema_before=20261102160814608\n")
        (self.backup / "data").mkdir()
        self.database(self.data, 20261102160814609)
        self.database(self.backup / "data", 20261102160814608)

    def app(self, target, version):
        (target / "Contents").mkdir(parents=True)
        with (target / "Contents/Info.plist").open("wb") as output:
            plistlib.dump({"CFBundleIdentifier": "dev.agent-orchestrator.desktop", "CFBundleShortVersionString": version, "NoetaxisDatabaseSchema": "20261102160814608"}, output)

    def database(self, directory, version):
        with sqlite3.connect(str(directory / "ao.db")) as db:
            db.execute("CREATE TABLE goose_db_version(version_id INTEGER, is_applied INTEGER)")
            db.execute("INSERT INTO goose_db_version VALUES (?, 1)", (version,))
            db.execute("CREATE TABLE content(value TEXT)")
            db.execute("INSERT INTO content VALUES (?)", (str(version),))

    def restore(self, restore_db=True, seconds=30):
        return module.Restore(self.backup, self.target, self.data, restore_db, seconds)

    def version(self):
        with (self.target / "Contents/Info.plist").open("rb") as source:
            return plistlib.load(source)["CFBundleShortVersionString"]

    def test_newer_committed_migrations_block_old_app_before_promotion(self):
        restore = self.restore(False)
        with self.assertRaisesRegex(RuntimeError, "database is newer"):
            restore.run()
        self.assertEqual(self.version(), "new")
        self.assertFalse(restore.fence.exists())
        self.assertEqual(restore.schema(self.data), 20261102160814609)

    def test_restore_and_clean_retry_preserve_exact_schema_and_new_app(self):
        restore = self.restore()
        restore.run()
        self.assertEqual(self.version(), "old")
        self.assertEqual(restore.schema(self.data), 20261102160814608)
        self.assertTrue((self.backup / "rollback-new-app.app").exists())
        self.assertTrue(json.loads(restore.journal_path.read_text())["completed"])
        self.assertFalse(restore.fence.exists())
        restore.atomic_json(restore.fence, {"journal": str(restore.journal_path)})
        self.restore().run()
        self.assertFalse(restore.fence.exists())

    def test_deadline_logs_error_and_never_claims_completion(self):
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("rollback-restore.py")), str(self.backup), str(self.target), str(self.data), "1", "-1"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 61, result.stderr)
        self.assertEqual(self.version(), "new")
        journal = json.loads((self.backup / "rollback-journal.json").read_text())
        self.assertTrue(journal["attempted"])
        self.assertFalse(journal["completed"])
        self.assertIn("deadline", journal["error"])
        self.assertIn("FINAL restore_completed=0", (self.backup / "update-actions.log").read_text())

    def test_interrupted_multifile_promotion_recovers_from_immutable_stage(self):
        restore = self.restore()
        original_copy = restore.copy_verified
        def interrupt(source, target):
            original_copy(source, target)
            if target == self.data / "ao.db":
                raise TimeoutError("interrupted after first database promotion")
        restore.copy_verified = interrupt
        with self.assertRaises(TimeoutError):
            restore.run()
        self.assertEqual(self.version(), "new")
        self.assertTrue(restore.fence.exists())
        self.assertFalse(json.loads(restore.journal_path.read_text())["completed"])
        self.assertEqual(restore.schema(restore.current), 20261102160814609)
        self.restore().run()
        self.assertEqual(self.version(), "old")
        self.assertFalse(restore.fence.exists())
        self.assertEqual(restore.schema(self.data), 20261102160814608)

    def test_relative_restore_and_equivalent_retries_use_one_journal(self):
        previous_directory = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous_directory)
        restore = module.Restore("./backup", "./Applications/AO.app", "./data", True, 30)
        original_copy = restore.copy_verified
        def interrupt(source, target):
            original_copy(source, target)
            if target == self.data.resolve() / "ao.db":
                raise TimeoutError("interrupted promotion via relative backup")
        restore.copy_verified = interrupt
        with self.assertRaisesRegex(TimeoutError, "interrupted promotion"):
            restore.run()
        self.assertTrue(restore.fence.exists())
        self.assertEqual(json.loads(restore.fence.read_text())["journal"], str(restore.journal_path))
        for backup in ("./backup", str(self.backup.resolve()), "./backup/../backup/."):
            module.Restore(backup, self.target, self.data, True, 30).run()
            self.assertEqual(self.version(), "old")
            self.assertFalse(restore.fence.exists())
            self.assertEqual(restore.schema(self.data.resolve()), 20261102160814608)

    def test_normalizes_legacy_relative_fence_on_absolute_retry(self):
        previous_directory = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous_directory)
        restore = self.restore()
        restore.atomic_json(restore.fence, {"journal": "./backup/../backup/rollback-journal.json"})
        restore.run()
        self.assertEqual(self.version(), "old")
        self.assertFalse(restore.fence.exists())

    def test_pre_promotion_failure_releases_fence_and_can_retry(self):
        snapshot = self.backup / "data/ao.db"
        contents = snapshot.read_bytes()
        snapshot.unlink()
        script = Path(__file__).with_name("rollback-restore.py")
        result = subprocess.run([sys.executable, "-B", str(script), "./backup", "./Applications/AO.app", "./data", "1", "30"], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 61, result.stderr)
        self.assertEqual(self.version(), "new")
        self.assertFalse((self.data / "RESTORE_IN_PROGRESS").exists())
        snapshot.write_bytes(contents)
        self.restore().run()
        self.assertEqual(self.version(), "old")

    def test_held_daemon_lock_blocks_all_restore(self):
        with (self.data / "daemon.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.restore().run()
        self.assertEqual(self.version(), "new")
        self.assertFalse((self.backup / "rollback-journal.json").exists())

    def test_refused_cli_does_not_remove_another_restore_fence(self):
        fence = self.data / "RESTORE_IN_PROGRESS"
        fence.write_text(json.dumps({"journal": "another-backup"}))
        with (self.data / "daemon.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("rollback-restore.py")), str(self.backup), str(self.target), str(self.data), "1", "30"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 61)
        self.assertEqual(json.loads(fence.read_text())["journal"], "another-backup")
        self.assertFalse((self.backup / "rollback-journal.json").exists())
        with self.assertRaisesRegex(RuntimeError, "Another backup"):
            self.restore().run()
        self.assertTrue(fence.exists())


if __name__ == "__main__":
    unittest.main()
