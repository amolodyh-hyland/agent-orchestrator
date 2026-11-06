import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import sqlite3
import sys
import time


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Restore:
    def __init__(self, backup, target, data, restore_db, seconds):
        self.backup, self.target, self.data = [Path(value).resolve() for value in (backup, target, data)]
        self.restore_db = restore_db
        self.lock_acquired = False
        self.fence_created = False
        self.deadline = time.monotonic() + seconds
        self.journal_path = self.backup / "rollback-journal.json"
        self.fence = self.data / "RESTORE_IN_PROGRESS"
        self.stage = self.backup / "rollback-stage"
        self.current = self.backup / "rollback-current-data"
        self.log = self.backup / "update-actions.log"
        self.state = {"attempted": True, "completed": False, "phase": "preflight", "restoreDb": restore_db}
        if self.journal_path.exists():
            self.state = json.loads(self.journal_path.read_text())
            if self.state["phase"] in ("promoting-database", "promoting-app", "completed"):
                self.state["promotionStarted"] = True
            if self.state["restoreDb"] != restore_db:
                if self.state["phase"] != "preflight":
                    raise RuntimeError("Retry with the same --restore-db choice as the journal")
                self.state["restoreDb"] = restore_db

    def check_deadline(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError("Rollback deadline reached; retry the same backup to recover")

    def atomic_json(self, path, value):
        temporary = path.with_suffix(path.suffix + ".tmp")
        with open(temporary, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        if os.geteuid() == 0 and self.data.exists():
            info = self.data.stat()
            os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, path)
        sync_directory(path.parent)

    def event(self, text):
        with self.log.open("a") as output:
            output.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " ROLLBACK " + text + "\n")
            output.flush()
            os.fsync(output.fileno())

    def phase(self, value):
        self.state["phase"] = value
        if value in ("promoting-database", "promoting-app"):
            self.state["promotionStarted"] = True
        self.atomic_json(self.journal_path, self.state)
        self.event(value)
        self.check_deadline()

    def copy_verified(self, source, target):
        self.check_deadline()
        temporary = target.with_name(target.name + ".copy")
        digest = hashlib.sha256()
        with source.open("rb") as incoming, temporary.open("wb") as outgoing:
            while True:
                self.check_deadline()
                chunk = incoming.read(1024 * 1024)
                if not chunk:
                    break
                outgoing.write(chunk)
                digest.update(chunk)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        check = hashlib.sha256()
        with temporary.open("rb") as incoming:
            while True:
                self.check_deadline()
                chunk = incoming.read(1024 * 1024)
                if not chunk:
                    break
                check.update(chunk)
        if check.digest() != digest.digest():
            raise RuntimeError("Staged database verification failed")
        os.chmod(temporary, 0o600)
        if os.geteuid() == 0:
            info = self.data.stat()
            os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, target)
        sync_directory(target.parent)

    def schema(self, directory):
        database = directory / "ao.db"
        if not database.exists():
            return 0
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            result = connection.execute("SELECT MAX(version_id) FROM goose_db_version WHERE is_applied=1").fetchone()[0]
        if result is None:
            raise RuntimeError("Cannot establish database schema")
        return int(result)

    def metadata(self, app):
        with (app / "Contents/Info.plist").open("rb") as source:
            return plistlib.load(source)

    def run(self):
        self.data.mkdir(parents=True, exist_ok=True)
        with (self.data / "daemon.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock_acquired = True
            try:
                return self.restore_locked()
            except Exception as error:
                self.record_failure(error)
                raise

    def record_failure(self, error):
        self.state["error"] = str(error)
        self.state["completed"] = False
        self.atomic_json(self.journal_path, self.state)
        self.log_failure(error)
        if not self.state.get("promotionStarted") and self.fence_created:
            (self.current / "VERIFIED").unlink(missing_ok=True)
            if self.current.exists():
                sync_directory(self.current)
            self.fence.unlink(missing_ok=True)
            sync_directory(self.data)

    def log_failure(self, error):
        self.event("ERROR " + str(error))
        self.event("FINAL restore_completed=0 phase=" + self.state["phase"] + " app=" + ("present" if self.target.exists() else "retained-in-backup") + " database=recovery-journal")

    def restore_locked(self):
        record = dict(line.split("=", 1) for line in (self.backup / "BACKUP_COMPLETE").read_text().splitlines() if "=" in line)
        name = record["app_backup"]
        if Path(name).name != name or name == "NONE":
            raise RuntimeError("Invalid or missing app backup")
        app_backup = self.backup / name
        expected = record["app_version"]
        source_app = app_backup if app_backup.exists() else self.target
        metadata = self.metadata(source_app)
        if metadata.get("CFBundleIdentifier") != "dev.agent-orchestrator.desktop" or metadata.get("CFBundleShortVersionString") != expected:
            raise RuntimeError("Backup app version does not match its record")
        maximum = metadata.get("NoetaxisDatabaseSchema")
        if not maximum or not str(maximum).isdigit():
            raise RuntimeError("Unknown old-app schema compatibility; new app retained")
        if record.get("schema_before", "").isdigit():
            maximum = min(int(maximum), int(record["schema_before"]))
        if self.fence.exists():
            recorded_journal = json.loads(self.fence.read_text()).get("journal")
            if not recorded_journal or Path(recorded_journal).resolve() != self.journal_path:
                raise RuntimeError("Another backup has an incomplete restore; recover its recorded journal first")
        if self.state.get("completed"):
            if self.metadata(self.target).get("CFBundleShortVersionString") != expected or self.schema(self.data) > int(maximum):
                raise RuntimeError("Completed restore no longer matches on-disk state")
            self.fence.unlink(missing_ok=True)
            sync_directory(self.data)
            self.event("FINAL restore_completed=1 completed-journal-verified")
            return
        if not self.restore_db and self.schema(self.data) > int(maximum):
            raise RuntimeError("rollback-blocked / new app retained: database is newer than the old app; a matched --restore-db snapshot is required")
        self.atomic_json(self.fence, {"journal": str(self.journal_path)})
        self.fence_created = True
        self.atomic_json(self.journal_path, self.state)
        self.check_deadline()
        if self.restore_db:
            self.stage.mkdir(exist_ok=True)
            if os.geteuid() == 0:
                info = self.data.stat()
                os.chown(self.stage, info.st_uid, info.st_gid)
            if not (self.stage / "VERIFIED").exists():
                self.phase("staging-database")
                if not (self.backup / "data/ao.db").is_file():
                    raise RuntimeError("Database snapshot missing")
                for name in ("ao.db", "ao.db-wal", "ao.db-shm"):
                    source = self.backup / "data" / name
                    if source.exists():
                        self.copy_verified(source, self.stage / name)
                if self.schema(self.stage) > int(maximum):
                    raise RuntimeError("Database snapshot is newer than the old app")
                self.atomic_json(self.stage / "VERIFIED", {"schema": str(self.schema(self.stage))})
            if not (self.current / "VERIFIED").exists():
                self.phase("saving-current-database")
                self.current.mkdir(exist_ok=True)
                if os.geteuid() == 0:
                    info = self.data.stat()
                    os.chown(self.current, info.st_uid, info.st_gid)
                for name in ("ao.db", "ao.db-wal", "ao.db-shm"):
                    if (self.data / name).exists():
                        self.copy_verified(self.data / name, self.current / name)
                    else:
                        (self.current / name).unlink(missing_ok=True)
                self.atomic_json(self.current / "VERIFIED", {"complete": True})
            self.phase("promoting-database")
            for name in ("ao.db", "ao.db-wal", "ao.db-shm"):
                source = self.stage / name
                if source.exists():
                    self.copy_verified(source, self.data / name)
                else:
                    (self.data / name).unlink(missing_ok=True)
            sync_directory(self.data)
        elif self.schema(self.data) > int(maximum):
            raise RuntimeError("rollback-blocked / new app retained: database is newer than the old app; a matched --restore-db snapshot is required")
        self.phase("promoting-app")
        retained = self.backup / "rollback-new-app.app"
        if app_backup.exists():
            if self.target.exists():
                if retained.exists():
                    raise RuntimeError("Retained new app already exists; inspect the journal")
                os.replace(self.target, retained)
            os.replace(app_backup, self.target)
            sync_directory(self.target.parent)
            sync_directory(self.backup)
        if self.metadata(self.target).get("CFBundleShortVersionString") != expected:
            raise RuntimeError("Restored app version mismatch")
        if self.schema(self.data) > int(maximum):
            raise RuntimeError("Restored app/database schema mismatch")
        self.state.pop("error", None)
        self.state.update(completed=True, phase="completed", appVersion=expected, schema=str(self.schema(self.data)))
        self.atomic_json(self.journal_path, self.state)
        self.fence.unlink(missing_ok=True)
        sync_directory(self.data)
        self.event("FINAL restore_completed=1 app=previous database=" + ("snapshot" if self.restore_db else "retained"))


def main():
    restore = None
    try:
        restore = Restore(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1", float(sys.argv[5]))
        def interrupted(signum, frame):
            raise InterruptedError("Rollback interrupted by signal " + str(signum))
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, interrupted)
        restore.run()
        return 0
    except Exception as error:
        if restore is not None and not restore.lock_acquired:
            restore.log_failure(error)
        print("Rollback blocked: " + str(error), file=sys.stderr)
        return 61


if __name__ == "__main__":
    sys.exit(main())
