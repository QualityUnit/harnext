"""Tests for CLI version detection + best-effort auto-upgrade orchestration."""

from __future__ import annotations

import pytest

import harnext_sdk._version as ver
from harnext_sdk import HarnextAgentOptions, is_behind, parse_version


@pytest.fixture(autouse=True)
def _reset_state():
    ver._checked.clear()
    ver._lock = None
    yield
    ver._checked.clear()
    ver._lock = None


def test_parse_version():
    assert parse_version("1.3.2") == (1, 3, 2)
    assert parse_version("v1.3.2\n") == (1, 3, 2)
    assert parse_version("1.3.3-beta.1") == (1, 3, 3)
    assert parse_version("2") == (2,)
    assert parse_version("") == ()
    assert parse_version("garbage") == ()


def test_is_behind():
    assert is_behind("1.3.2", "1.3.3") is True
    assert is_behind("1.3.3", "1.3.3") is False
    assert is_behind("1.4.0", "1.3.3") is False  # CLI ahead — leave it
    assert is_behind("2.0.0", "1.9.9") is False
    assert is_behind("", "1.3.3") is False  # unknown — no action
    assert is_behind("1.3.2", "") is False


def _recorder(out):
    def _resolve(*_args, **_kwargs):
        out.append(True)
        return ["harnext"]

    return _resolve


async def test_skips_when_cli_path_set(monkeypatch):
    resolved: list[bool] = []
    monkeypatch.setattr(ver, "resolve_cli_invocation", _recorder(resolved))
    await ver.ensure_cli_version(HarnextAgentOptions(cli_path="/tmp/stub"))
    assert resolved == []  # returned before resolving anything


async def test_skips_when_env_cli_path(monkeypatch):
    resolved: list[bool] = []
    monkeypatch.setenv("HARNEXT_CLI_PATH", "/tmp/x")
    monkeypatch.setattr(ver, "resolve_cli_invocation", _recorder(resolved))
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert resolved == []


async def test_skips_when_disabled_via_option(monkeypatch):
    resolved: list[bool] = []
    monkeypatch.setattr(ver, "resolve_cli_invocation", _recorder(resolved))
    await ver.ensure_cli_version(HarnextAgentOptions(auto_update_cli=False))
    assert resolved == []


async def test_skips_when_disabled_via_env(monkeypatch):
    resolved: list[bool] = []
    monkeypatch.setenv("HARNEXT_NO_CLI_AUTOUPDATE", "1")
    monkeypatch.setattr(ver, "resolve_cli_invocation", _recorder(resolved))
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert resolved == []


def _patch_global_cli(monkeypatch, *, cli_version: str, sdk_version: str = "1.3.3"):
    monkeypatch.delenv("HARNEXT_CLI_PATH", raising=False)
    monkeypatch.setattr(ver, "resolve_cli_invocation", lambda *_a, **_k: ["harnext"])
    monkeypatch.setattr(ver, "_sdk_version", lambda: sdk_version)

    async def fake_cli_version(_base):
        return cli_version

    monkeypatch.setattr(ver, "_cli_version", fake_cli_version)
    upgrades: list[str] = []

    async def fake_upgrade(version, _options):
        upgrades.append(version)
        return True

    monkeypatch.setattr(ver, "_upgrade", fake_upgrade)
    return upgrades


async def test_upgrades_when_cli_behind(monkeypatch):
    upgrades = _patch_global_cli(monkeypatch, cli_version="1.3.2", sdk_version="1.3.3")
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert upgrades == ["1.3.3"]


async def test_no_upgrade_when_matching(monkeypatch):
    upgrades = _patch_global_cli(monkeypatch, cli_version="1.3.3", sdk_version="1.3.3")
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert upgrades == []


async def test_no_upgrade_when_cli_ahead(monkeypatch):
    upgrades = _patch_global_cli(monkeypatch, cli_version="1.4.0", sdk_version="1.3.3")
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert upgrades == []


async def test_no_upgrade_when_cli_version_unknown(monkeypatch):
    monkeypatch.delenv("HARNEXT_CLI_PATH", raising=False)
    monkeypatch.setattr(ver, "resolve_cli_invocation", lambda *_a, **_k: ["harnext"])
    monkeypatch.setattr(ver, "_sdk_version", lambda: "1.3.3")

    async def fake_cli_version(_base):
        return None

    upgrades: list[str] = []

    async def fake_upgrade(version, _options):
        upgrades.append(version)
        return True

    monkeypatch.setattr(ver, "_cli_version", fake_cli_version)
    monkeypatch.setattr(ver, "_upgrade", fake_upgrade)
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert upgrades == []


async def test_checks_at_most_once_per_process(monkeypatch):
    monkeypatch.delenv("HARNEXT_CLI_PATH", raising=False)
    monkeypatch.setattr(ver, "resolve_cli_invocation", lambda *_a, **_k: ["harnext"])
    monkeypatch.setattr(ver, "_sdk_version", lambda: "1.3.3")
    calls = {"n": 0}

    async def fake_cli_version(_base):
        calls["n"] += 1
        return "1.3.2"

    async def fake_upgrade(_version, _options):
        return True

    monkeypatch.setattr(ver, "_cli_version", fake_cli_version)
    monkeypatch.setattr(ver, "_upgrade", fake_upgrade)
    await ver.ensure_cli_version(HarnextAgentOptions())
    await ver.ensure_cli_version(HarnextAgentOptions())
    assert calls["n"] == 1
