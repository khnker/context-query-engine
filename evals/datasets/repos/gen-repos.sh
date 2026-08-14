#!/usr/bin/env bash
# Genera repos sintéticos T1 para el benchmark harness (change benchmark-harness).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # evals/datasets
REPOS="$ROOT/repos"

rm -rf "$REPOS/t1-basic" "$REPOS/t1-modular"
mkdir -p "$REPOS/t1-basic/src/services" "$REPOS/t1-basic/src/utils" "$REPOS/t1-basic/config" "$REPOS/t1-basic/tests"
mkdir -p "$REPOS/t1-modular/app/core" "$REPOS/t1-modular/app/handlers" "$REPOS/t1-modular/app/config" "$REPOS/t1-modular/tests"

# ── t1-basic (TypeScript) ────────────────────────────────────────────────
cat > "$REPOS/t1-basic/package.json" <<'EOF'
{
  "name": "t1-basic",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/" }
}
EOF
cat > "$REPOS/t1-basic/tsconfig.json" <<'EOF'
{ "compilerOptions": { "module": "ESNext", "target": "ES2022", "strict": true, "moduleResolution": "bundler" } }
EOF
cat > "$REPOS/t1-basic/README.md" <<'EOF'
# t1-basic

Synthetic repo. Implements fallback between providers through retryWithFallback
and ProviderRouter.route. Config read from config/providers.json.
EOF
cat > "$REPOS/t1-basic/src/services/fallback.ts" <<'EOF'
import { readFileSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 5000;

export interface ProviderConfig {
  primary: string;
  fallback: string;
  backup: string;
}

export function loadProviders(): ProviderConfig {
  const raw = readFileSync(new URL('../../config/providers.json', import.meta.url), 'utf-8');
  return JSON.parse(raw) as ProviderConfig;
}

export async function retryWithFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  try {
    const result = await Promise.race([primary(), timeout(timeoutMs)]);
    return result;
  } catch {
    console.log('primary provider failed, falling back');
    return fallback();
  }
}

function timeout<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

export class ProviderRouter {
  private config: ProviderConfig;

  constructor(config?: ProviderConfig) {
    this.config = config ?? loadProviders();
  }

  async route(modelId: string): Promise<string> {
    return retryWithFallback(
      () => this.call(this.config.primary, modelId),
      () => this.call(this.config.fallback, modelId),
    );
  }

  private async call(provider: string, modelId: string): Promise<string> {
    return `${provider}:${modelId}`;
  }
}
EOF
cat > "$REPOS/t1-basic/src/utils/decorators.ts" <<'EOF'
// Decoy: same class name as the real ProviderRouter in services/fallback.ts.
export class ProviderRouter {
  constructor(private baseUrl: string) {}

  buildPath(modelId: string): string {
    return `${this.baseUrl}/models/${modelId}`;
  }
}
EOF
cat > "$REPOS/t1-basic/src/utils/helpers.ts" <<'EOF'
// Decoy: same function name as the real retryWithFallback in services/fallback.ts.
import { retryWithFallback } from '../services/fallback.js';

export function retryWithFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  return retryWithFallback(primary, fallback);
}
EOF
cat > "$REPOS/t1-basic/src/config.ts" <<'EOF'
import { DEFAULT_TIMEOUT_MS } from './services/fallback.js';

export function effectiveTimeout(userTimeout?: number): number {
  return userTimeout ?? DEFAULT_TIMEOUT_MS;
}
EOF
cat > "$REPOS/t1-basic/config/providers.json" <<'EOF'
{
  "primary": "zen-free",
  "fallback": "groq",
  "backup": "nvidia-nim"
}
EOF
cat > "$REPOS/t1-basic/tests/fallback.test.ts" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithFallback, ProviderRouter } from '../src/services/fallback.js';

test('retryWithFallback returns primary result', async () => {
  const out = await retryWithFallback(async () => 'ok', async () => 'fb');
  assert.equal(out, 'ok');
});

test('retryWithFallback falls back when primary throws', async () => {
  const out = await retryWithFallback(async () => { throw new Error('down'); }, async () => 'fb');
  assert.equal(out, 'fb');
});

test('ProviderRouter.route uses fallback provider', async () => {
  const router = new ProviderRouter({ primary: 'a', fallback: 'b', backup: 'c' });
  const out = await router.route('m1');
  assert.match(out, /^(a|b):m1$/);
});
EOF

# ── t1-modular (Python) ──────────────────────────────────────────────────
cat > "$REPOS/t1-modular/pyproject.toml" <<'EOF'
[project]
name = "t1-modular"
version = "0.1.0"
requires-python = ">=3.11"
EOF
cat > "$REPOS/t1-modular/README.md" <<'EOF'
# t1-modular

Synthetic python repo: handler registry with fallback to a default handler.
Config read from app/config/settings.yaml.
EOF
cat > "$REPOS/t1-modular/app/__init__.py" <<'EOF'
EOF
cat > "$REPOS/t1-modular/app/core/__init__.py" <<'EOF'
EOF
cat > "$REPOS/t1-modular/app/core/registry.py" <<'EOF'
from __future__ import annotations

from typing import Callable

HANDLERS: dict[str, Callable[[str], str]] = {}

DEFAULT_HANDLER = "default"


def register(name: str, handler: Callable[[str], str]) -> None:
    HANDLERS[name] = handler


def get(name: str) -> Callable[[str], str]:
    try:
        return HANDLERS[name]
    except KeyError:
        return HANDLERS[DEFAULT_HANDLER]
EOF
cat > "$REPOS/t1-modular/app/core/config.py" <<'EOF'
from __future__ import annotations

import yaml
from pathlib import Path

_SETTINGS: dict | None = None


def _load() -> dict:
    global _SETTINGS
    if _SETTINGS is None:
        with open(Path(__file__).resolve().parents[1] / "config" / "settings.yaml") as fh:
            _SETTINGS = yaml.safe_load(fh)
    return _SETTINGS


def get_provider_config(name: str) -> dict:
    providers = _load().get("providers", {})
    return providers.get(name, {})
EOF
cat > "$REPOS/t1-modular/app/handlers/__init__.py" <<'EOF'
EOF
cat > "$REPOS/t1-modular/app/handlers/http.py" <<'EOF'
from app.core.registry import register, get


class HttpHandler:
    def handle(self, request: str) -> str:
        return f"http:{request}"


def install() -> None:
    register("http", HttpHandler().handle)
EOF
cat > "$REPOS/t1-modular/app/handlers/file.py" <<'EOF'
from app.core.registry import get


def process(path: str) -> str:
    handler = get("missing-handler")  # falls back to default
    return handler(path)
EOF
cat > "$REPOS/t1-modular/app/config/settings.yaml" <<'EOF'
providers:
  default: stdio
  backup: file
timeouts:
  request_ms: 1000
EOF
cat > "$REPOS/t1-modular/tests/test_registry.py" <<'EOF'
from app.core.registry import register, get


def test_register_and_get():
    register("echo", lambda s: s)
    assert get("echo")("hi") == "hi"


def test_get_falls_back_to_default():
    register("default", lambda s: f"default:{s}")
    assert get("nope")("x") == "default:x"
EOF

# ── git history ──────────────────────────────────────────────────────────
git -C "$REPOS/t1-basic" init -q
git -C "$REPOS/t1-basic" add -A
git -C "$REPOS/t1-basic" -c user.name="bench" -c user.email="bench@local" commit -qm "base"
printf '\nconsole.log("request routed");\n' >> "$REPOS/t1-basic/src/services/fallback.ts"
git -C "$REPOS/t1-basic" add -A
git -C "$REPOS/t1-basic" -c user.name="bench" -c user.email="bench@local" commit -qm "add routing log"

git -C "$REPOS/t1-modular" init -q
git -C "$REPOS/t1-modular" add -A
git -C "$REPOS/t1-modular" -c user.name="bench" -c user.email="bench@local" commit -qm "base"

echo "OK repos generados:"
ls "$REPOS"
