"""只读取已保存证据的离线审计；不启动 Electron，不消耗新的场景额度。"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "artifacts"


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


budget = read(ARTIFACTS / "budget.json")
expected = {
    "run-1": (3, {"reloaded-A-input-stops-only-A", "B-can-continue-after-A-reload-input"}),
    "run-2": (3, {"reloaded-A-input-stops-only-A", "B-can-continue-after-A-reload-input"}),
    "run-3": (7, {"reloaded-A-input-stops-only-A", "B-can-continue-after-A-reload-input"}),
    "run-4": (31, {"host-view-switch-and-chat:completed"}),
    "run-5": (35, set()),
    "run-6": (15, set()),
}
require(budget["launches"] == len(expected) == len(budget["attempts"]), "launch accounting")
require(budget["cases"] <= 40 and budget["launches"] <= 8, "budget ceiling")
require(len(budget["sourceVersions"]) == 4, "tested source versions")
require(budget["modelCalls"] == budget["remoteWrites"] == 0, "external budget")
require(max(a["finishedAt"] for a in budget["attempts"]) - budget["startedAt"] < 3600000, "runtime deadline")
total_cases = 0
summary = []

for attempt in budget["attempts"]:
    folder = ROOT / attempt["out"]
    checks = read(folder / "checks.json")
    result = read(folder / "result.json")
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()]
    receipts = read(folder / "server.json")
    hashes = read(folder / "source/hashes.json")
    expected_count, expected_failures = expected[folder.name]
    require(len(checks) == expected_count, f"{folder.name}: checks count")
    require({c["name"] for c in checks if not c["pass"]} == expected_failures, f"{folder.name}: retained failures")
    require(result["checks"] == checks and result["receipts"] == receipts, f"{folder.name}: persisted result")
    require(result["pass"] == (not expected_failures), f"{folder.name}: pass label")
    require(attempt["exitCode"] == (1 if expected_failures else 0), f"{folder.name}: exit status")
    source_hashes = {name: sha for name, sha in hashes.items() if not name.endswith(".node")}
    for name, sha in source_hashes.items():
        require(digest(folder / "source" / name) == sha, f"{folder.name}: source {name}")
    fingerprint = hashlib.sha256(json.dumps(source_hashes, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    require(fingerprint == attempt["sourceVersion"], f"{folder.name}: source fingerprint")
    require(attempt["sourceVersion"] in budget["sourceVersions"], f"{folder.name}: registered version")
    require(all(e["seq"] == i + 1 for i, e in enumerate(events)), f"{folder.name}: event sequence")
    require(all(e["source"] == "automatic-native-probe" for e in events), f"{folder.name}: automatic evidence source")
    starts = [e for e in events if e["kind"] == "case-start"]
    total_cases += len(starts)
    native = [e for e in events if e["kind"] == "native-input"]
    repeated_keys = []
    for e in native:
        if e.get("testInjection") is not False:
            continue
        earlier = [p for p in native if p["seq"] < e["seq"] and p["testInjection"] and p["type"] == e["type"] == "keyDown" and p["timestamp"] == e["timestamp"] and p["keyCode"] == e["keyCode"]]
        require(bool(earlier), f"{folder.name}: unaccounted native input")
        repeated_keys.append({"originalSeq": earlier[-1]["seq"], "repeatedSeq": e["seq"], "timestamp": e["timestamp"]})
    candidate_details = None
    if attempt["mode"] == "candidate":
        cases = read(folder / "cases.json")
        require([c["name"] for c in cases] == [e["name"] for e in starts], f"{folder.name}: case accounting")
        require([c for case in cases for c in case["checks"]] == checks, f"{folder.name}: case checks")
        active = {"A": True, "B": True}
        generation = {"A": 1, "B": 1}
        verified = {}
        resumes = 0
        for e in events:
            task = e.get("task")
            if e["kind"] == "stop":
                active[task] = False
            elif e["kind"] == "new-execution":
                active[task], generation[task] = True, e["generation"]
            elif e["kind"] == "binding-invalidated":
                verified.pop(task, None)
            elif e["kind"] == "current-page-verified":
                verified[task] = e
            elif e["kind"] == "resumed-after-verification":
                v = verified.get(task)
                require(v and v["binding"]["serial"] == e["bindingSerial"] and v["current"] == e["current"], f"{folder.name}: verify before resume {e['seq']}")
                if not e["explicit"]:
                    require(set(v["reasons"]) <= {"document-change", "view-replaced", "connection-lost", "page-handle-closed"}, f"{folder.name}: automatic resume cleared stop")
                resumes += 1
            elif e["kind"] == "dispatch":
                require(active[task] and generation[task] == e["generation"] and task in verified, f"{folder.name}: dispatch from invalid/stopped execution {e['seq']}")
        require(not any(r["kind"] == "late" for r in receipts), f"{folder.name}: old click reached server")
        # 只计入 A 输入之后、再次继续之前，B 确实重新派发且服务器收到的窗口。
        independent_progress = []
        for input_event in native:
            if input_event["owner"] != "A":
                continue
            end = next((e["at"] for e in events if e["seq"] > input_event["seq"] and e["kind"] == "resumed-after-verification" and e["task"] == "A"), events[-1]["at"])
            dispatches = [e for e in events if input_event["seq"] < e["seq"] and e["at"] < end and e["kind"] == "dispatch" and e["task"] == "B" and e["operation"] == "auto-tick"]
            actual = [r for r in receipts if r["task"] == "B" and any(d["at"] <= r["at"] < end for d in dispatches)]
            if actual:
                independent_progress.append({"inputSeq": input_event["seq"], "type": input_event["type"], "BDispatchSeqs": [d["seq"] for d in dispatches], "BReceiptCounts": [r["count"] for r in actual]})
        require(bool(independent_progress), f"{folder.name}: no actual B progress while A paused")
        if folder.name == "run-5":
            require({p["type"] for p in independent_progress} == {"mouseDown", "keyDown"}, "final full run: mouse and keyboard B progress")
        candidate_details = {"resumesVerified": resumes, "independentProgress": independent_progress, "lateReceipts": 0}
    artifact_hashes = {str(p.relative_to(folder)): digest(p) for p in sorted(folder.rglob("*")) if p.is_file() and "profiles" not in p.relative_to(folder).parts}
    summary.append({"run": folder.name, "mode": attempt["mode"], "sourceVersion": attempt["sourceVersion"], "cases": len(starts), "checks": len(checks), "passedChecks": sum(c["pass"] for c in checks), "expectedFailures": sorted(expected_failures), "nativeInputs": len(native), "unknownInputs": [e["seq"] for e in native if e["owner"] == "unknown"], "repeatedProbeKeys": repeated_keys, "candidate": candidate_details, "artifactSha256": artifact_hashes})

require(total_cases == budget["cases"] == 35, "total case accounting")
latest = read(ARTIFACTS / "run-6/source/hashes.json")
for name in ("PLAN.md", "fixture.html", "run.mjs", "electron.cjs", "ownership.cjs", "cases.cjs", "native/input-monitor.mm", "build.mjs"):
    require(digest(ROOT / name) == latest[name], f"final source differs: {name}")
binary_checks = {}
for name, path in {"candidate-native.node": ROOT / "build/input-monitor.node", "legacy-native.node": ROOT / "../human-input-takeover/build/input-monitor.node"}.items():
    if path.exists():
        require(digest(path) == latest[name], f"native binary differs: {name}")
        binary_checks[name] = "verified-present-local-build"
    else:
        binary_checks[name] = "not-retained-in-git; source-and-recorded-hash-only"
native_diagnosis = read(ARTIFACTS / "run-3/native-before-after.json")
require(native_diagnosis["before"]["chain"][0]["identity"] != native_diagnosis["after"]["chain"][0]["identity"], "diagnostic leaf did not change")
require(native_diagnosis["before"]["chain"][1]["identity"] == native_diagnosis["after"]["chain"][1]["identity"], "diagnostic outer view changed")
require(native_diagnosis["before"]["owner"] == "A" and native_diagnosis["after"]["owner"] == "unknown", "diagnostic owner")
document = {"audit": "passed", "auditorSha256": digest(Path(__file__)), "budgetSha256": digest(ARTIFACTS / "budget.json"), "launches": budget["launches"], "cases": total_cases, "sourceVersions": len(budget["sourceVersions"]), "binaryChecks": binary_checks, "operatorSource": "automatic-native-probe; no new human samples", "runs": summary}
(ARTIFACTS / "evidence-index.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: document[k] for k in ("audit", "launches", "cases", "sourceVersions")}, ensure_ascii=False))
