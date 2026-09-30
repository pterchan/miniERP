"""用假 Docker/curl 运行实际远端脚本，验证发布顺序及失败后的停机状态。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REMOTE_SCRIPT = (ROOT / "deploy/deploy_remote.sh").read_text(encoding="utf-8").split("<<'REMOTE_SCRIPT'\n", 1)[1].rsplit("\nREMOTE_SCRIPT", 1)[0]

FAKE_TOOL = """\
import json
import os
import sys
from pathlib import Path

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
state_path = Path(os.environ["DEPLOY_TEST_STATE"])
state = json.loads(state_path.read_text())
with open(os.environ["DEPLOY_TEST_LOG"], "a") as log:
    log.write(json.dumps({"tool": tool, "args": args}) + "\\n")
mode = os.environ["DEPLOY_TEST_MODE"]
status = 0
if tool == "docker":
    operation = args[3]
    if operation == "build" and mode == "build_failure":
        status = 2
    elif operation == "stop":
        state["api"] = state["web"] = False
    elif operation == "up" and args[-1] == "postgres":
        state["postgres"] = True
    elif operation == "exec" and "pg_isready" in args[-1]:
        state["probes"] += 1
        status = int(mode == "database_timeout" or state["probes"] < 2)
    elif operation == "exec":
        if mode == "migration_failure":
            status = 3
        else:
            state["schema_ready"] = True
    elif operation == "up":
        if not state["schema_ready"]:
            status = 91
        else:
            state["api"] = True
            state["web"] = mode != "startup_failure"
            status = int(mode == "startup_failure")
    elif operation == "port":
        if mode == "port_failure":
            status = 4
        else:
            print("127.0.0.1:" + os.environ["DEPLOY_TEST_PUBLISHED_PORT"])
elif tool == "curl":
    status = int(mode == "health_failure")
state_path.write_text(json.dumps(state))
sys.exit(status)
"""


class DeploymentSequenceTests(unittest.TestCase):
    def run_release(self, mode="success", running=True, dotenv="WEB_PORT=127.0.0.1:18088\n", published_port="18088"):
        with tempfile.TemporaryDirectory(prefix="mini-erp-deploy-test-") as directory:
            task_dir = Path(directory)
            executable_dir = task_dir / "bin"
            executable_dir.mkdir()
            for name in ("docker", "curl"):
                executable = executable_dir / name
                executable.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE_TOOL), encoding="utf-8")
                executable.chmod(0o755)
            sleep = executable_dir / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            sleep.chmod(0o755)
            (task_dir / ".env").write_text(dotenv, encoding="utf-8")
            state_path = task_dir / "state.json"
            state_path.write_text(json.dumps({"api": running, "web": running, "postgres": False, "schema_ready": False, "probes": 0}))
            log_path = task_dir / "commands.jsonl"
            environment = dict(os.environ)
            environment.update({
                "PATH": f"{executable_dir}:{environment.get('PATH', '')}",
                "DEPLOY_TEST_MODE": mode, "DEPLOY_TEST_STATE": str(state_path),
                "DEPLOY_TEST_LOG": str(log_path),
                "DEPLOY_TEST_PUBLISHED_PORT": published_port,
            })
            result = subprocess.run(
                ["bash", "-s", "--", str(task_dir), "erp.example.com", "0"],
                input=REMOTE_SCRIPT, text=True, capture_output=True, env=environment, timeout=20,
            )
            commands = [json.loads(line) for line in log_path.read_text().splitlines()]
            return result, json.loads(state_path.read_text()), commands

    def test_build_then_pause_then_migrate_then_start(self):
        for running in (True, False):
            with self.subTest(existing_services=running):
                result, state, commands = self.run_release(running=running)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(state["api"] and state["web"] and state["schema_ready"])
                operations = [(i, entry["args"][3]) for i, entry in enumerate(commands) if entry["tool"] == "docker"]
                build = next(i for i, op in operations if op == "build")
                stop = next(i for i, op in operations if op == "stop")
                migration = next(i for i, entry in enumerate(commands) if entry["tool"] == "docker" and "for f in" in entry["args"][-1])
                start = next(i for i, entry in enumerate(commands) if "--no-build" in entry["args"])
                self.assertLess(build, stop)
                self.assertLess(stop, migration)
                self.assertLess(migration, start)
                probes = [entry["args"][-1] for entry in commands if "pg_isready" in entry["args"][-1]]
                self.assertTrue(probes)
                self.assertTrue(all("-h 127.0.0.1" in probe for probe in probes))
                self.assertIn("ON_ERROR_STOP=1", commands[migration]["args"][-1])
                self.assertTrue(any("http://127.0.0.1:18088/api/healthz" in entry["args"] for entry in commands))

    def test_quoted_dotenv_uses_published_port_and_bounded_health_request(self):
        for dotenv in ("WEB_PORT=\"127.0.0.1:18099\" # 测试注释\n", "WEB_PORT='127.0.0.1:18099'\n"):
            with self.subTest(dotenv=dotenv):
                result, state, commands = self.run_release(dotenv=dotenv, published_port="18099")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(state["api"] and state["web"])
                mapping = next(entry for entry in commands if entry["tool"] == "docker" and entry["args"][3] == "port")
                self.assertEqual(mapping["args"][-2:], ["web", "8080"])
                health = next(entry for entry in commands if entry["tool"] == "curl")
                self.assertIn("http://127.0.0.1:18099/api/healthz", health["args"])
                self.assertIn("--max-time", health["args"])
                self.assertIn("--connect-timeout", health["args"])

    def test_unavailable_or_invalid_mapping_stops_application(self):
        for mode, port in (("port_failure", "18088"), ("success", "invalid"), ("success", ""), ("success", "0"), ("success", "65536")):
            with self.subTest(mode=mode, port=port):
                result, state, commands = self.run_release(mode, published_port=port)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(state["api"] or state["web"])
                self.assertFalse(any(entry["tool"] == "curl" for entry in commands))
                self.assertIn("端口", result.stderr)

    def test_build_failure_leaves_old_services_running(self):
        result, state, commands = self.run_release("build_failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(state["api"] and state["web"])
        self.assertFalse(any(entry["tool"] == "docker" and entry["args"][3] == "stop" for entry in commands))

    def test_database_or_migration_failure_never_starts_new_application(self):
        for mode in ("database_timeout", "migration_failure"):
            with self.subTest(mode=mode):
                result, state, commands = self.run_release(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(state["api"] or state["web"])
                self.assertFalse(any("--no-build" in entry["args"] for entry in commands))
                self.assertIn("API/Web 已保持停止", result.stderr)

    def test_startup_or_health_failure_stops_application_again(self):
        for mode in ("startup_failure", "health_failure"):
            with self.subTest(mode=mode):
                result, state, commands = self.run_release(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(state["api"] or state["web"])
                stops = [entry for entry in commands if entry["tool"] == "docker" and entry["args"][3] == "stop"]
                self.assertEqual(len(stops), 2)


if __name__ == "__main__":
    unittest.main()
