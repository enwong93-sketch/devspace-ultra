"""Start the already-installed Blender MCP addon on one DevSpace-assigned loopback port.

The script is process-local: it disables preference auto-save before changing the
addon host/port so parallel Blender runtimes do not overwrite one another's
persistent user preferences.
"""
from __future__ import annotations

import bpy
import importlib
import json
import os
import traceback

HOST = os.environ.get("DEVSPACE_BLENDER_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ["DEVSPACE_BLENDER_PORT"])
RUNTIME_ID = os.environ.get("DEVSPACE_BLENDER_RUNTIME_ID", "blender-runtime")


def _emit(state: str, **extra) -> None:
    payload = {
        "runtime_id": RUNTIME_ID,
        "state": state,
        "host": HOST,
        "port": PORT,
        "blend_file": bpy.data.filepath,
        **extra,
    }
    print("DEVSPACE_BLENDER_RUNTIME " + json.dumps(payload, ensure_ascii=False), flush=True)


def _start() -> None:
    try:
        if HOST not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("DevSpace Blender Runtime only permits a loopback MCP host.")

        # Prevent process-local port selection from being persisted into the
        # user's shared Blender preferences while parallel runtimes are active.
        if hasattr(bpy.context.preferences, "use_preferences_save"):
            bpy.context.preferences.use_preferences_save = False

        addon = next(
            (item for item in bpy.context.preferences.addons if item.module.endswith(".mcp")),
            None,
        )
        if addon is None:
            raise RuntimeError("The Blender MCP addon is not enabled in this Blender profile.")

        preferences = addon.preferences
        if hasattr(preferences, "host"):
            preferences.host = HOST
        if hasattr(preferences, "port"):
            preferences.port = PORT

        server = importlib.import_module(addon.module + ".mcp_to_blender_server")
        if server.is_running():
            # A newly launched process should not already own another runtime's
            # endpoint. Stop only this process-local addon server before rebinding.
            stop_operator = getattr(getattr(bpy.ops, "blmcp", None), "server_stop", None)
            if stop_operator is not None:
                stop_operator()

        result = bpy.ops.blmcp.server_start()
        if not server.is_running():
            raise RuntimeError(f"Blender MCP server did not enter running state: {result!r}")

        _emit("ready", operator_result=sorted(str(value) for value in result))
    except Exception as exc:  # noqa: BLE001 - Blender needs a visible startup marker.
        _emit("failed", error=str(exc), traceback=traceback.format_exc())
        # A runtime launched by DevSpace has no useful control channel when the
        # addon cannot bind. Exit explicitly so the liveness-driven Node manager
        # can report the concrete failure instead of waiting forever.
        bpy.ops.wm.quit_blender()
        return None


bpy.app.timers.register(_start, first_interval=1.0)
