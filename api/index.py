"""Vercel entry point: exposes the FastAPI app from backend/app.py."""

import os
import sys
from pathlib import Path

# Vercel's file system is read-only except /tmp.
os.environ.setdefault("SPHEREX_CACHE", "/tmp/spherex-cache")
os.environ.setdefault("XDG_CONFIG_HOME", "/tmp")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import app  # noqa: E402,F401
