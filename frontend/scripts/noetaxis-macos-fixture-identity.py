import ctypes
import fcntl
import json
import os
import sys


class BSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
        "rgid", "svuid", "svgid", "reserved",
    )] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in (
            "nfiles", "pgid", "jobc", "tdev", "tpgid", "nice",
        )
    ] + [("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)


def bsd_info(pid):
    info = BSDInfo()
    if libproc.proc_pidinfo(pid, 3, ctypes.c_uint64(0), ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise OSError(ctypes.get_errno(), "proc_pidinfo failed")
    if info.pid != pid or not info.start_sec:
        raise ValueError("invalid process identity")
    return [str(info.start_sec), str(info.start_usec)]


def executable(pid):
    buffer = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, buffer, len(buffer)) <= 0:
        raise OSError(ctypes.get_errno(), "proc_pidpath failed")
    value = os.fsdecode(buffer.value)
    if not value.startswith("/"):
        raise ValueError("non-absolute executable")
    return value


def command(pid):
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    length = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "process arguments unavailable")
    buffer = ctypes.create_string_buffer(length.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(length), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "process arguments unavailable")
    raw = buffer.raw[:length.value]
    argc = int.from_bytes(raw[:4], sys.byteorder, signed=True)
    offset = raw.index(b"\0", 4) + 1
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    args = raw[offset:].split(b"\0")[:argc]
    if argc <= 0 or len(args) != argc:
        raise ValueError("invalid process arguments")
    return [os.fsdecode(arg) for arg in args]


def identity(pid):
    started = bsd_info(pid)
    path = executable(pid)
    args = command(pid)
    if bsd_info(pid) != started or executable(pid) != path or command(pid) != args:
        raise ValueError("process changed during lookup")
    return {"pid": pid, "start": started, "executable": path, "command": args}


try:
    mode = sys.argv[1]
    pid_arg = sys.argv[-1]
    pid = os.getpid() if pid_arg == "self" else int(pid_arg)
    if pid <= 1:
        raise ValueError("invalid pid")
    if mode == "register":
        root = sys.argv[2]
        with open(os.path.join(root, ".fixture-identities"), "a", encoding="utf8") as record:
            fcntl.flock(record, fcntl.LOCK_EX)
            result = identity(pid)
            record.write(json.dumps(result) + "\n")
    elif mode == "read":
        result = identity(pid)
    else:
        raise ValueError("invalid operation")
    print(json.dumps(result))
except (OSError, ValueError, IndexError):
    sys.exit(1)
