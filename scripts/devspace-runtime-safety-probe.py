"""Read-only Windows process/job membership for explicitly supplied PIDs."""
import ctypes
import json
import os
import sys
from ctypes import wintypes
import psutil

if os.name != "nt":
    raise SystemExit("Windows only")
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
rows = []
for raw in sys.argv[1:]:
    pid = int(raw)
    try:
        process = psutil.Process(pid)
        handle = kernel.OpenProcess(0x1000, False, pid)
        value = wintypes.BOOL()
        try:
            ok = bool(handle) and bool(kernel.IsProcessInJob(handle, None, ctypes.byref(value)))
            rows.append({"pid": pid, "parent": process.ppid(), "created": process.create_time(),
                         "jobQueryOk": ok, "inAnyJob": bool(value.value) if ok else None})
        finally:
            if handle:
                kernel.CloseHandle(handle)
    except psutil.NoSuchProcess:
        rows.append({"pid": pid, "absent": True})
kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
buffer = ctypes.create_string_buffer(128 * 1024)
size = wintypes.DWORD()
queried = bool(kernel.QueryInformationJobObject(None, 3, buffer, len(buffer), ctypes.byref(size)))
job = {"queryOk": queried, "error": ctypes.get_last_error() if not queried else None}
if queried:
    assigned = wintypes.DWORD.from_buffer(buffer, 0).value
    count = wintypes.DWORD.from_buffer(buffer, 4).value
    values = (ctypes.c_size_t * count).from_buffer(buffer, 8)
    requested = {int(value) for value in sys.argv[1:]}
    job.update({"assigned": assigned, "listed": count, "requestedPidsInCurrentJob": [int(value) for value in values if value in requested]})
limits = ctypes.create_string_buffer(144 if ctypes.sizeof(ctypes.c_void_p) == 8 else 112)
limits_ok = bool(kernel.QueryInformationJobObject(None, 9, limits, len(limits), ctypes.byref(size)))
job.update({"limitsQueryOk": limits_ok, "limitsError": ctypes.get_last_error() if not limits_ok else None})
if limits_ok:
    flags = wintypes.DWORD.from_buffer(limits, 16).value
    job.update({"limitFlags": flags, "killOnJobClose": bool(flags & 0x2000), "breakawayAllowed": bool(flags & 0x800), "silentBreakaway": bool(flags & 0x1000)})
print(json.dumps({"processes": rows, "currentJob": job}))
