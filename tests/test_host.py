# Copyright (C) 2026 Grigory Tuboltsev
# SPDX-License-Identifier: MIT
"""Protocol tests of the native host against a fake speechd (no sound)."""
import importlib.machinery, importlib.util, io, json, os, struct, sys, types

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "host", "speechd-reader-host")

log = []

class FakeClient:
    def __init__(self, *a, **k): log.append(("connect",))
    def set_language(self, l): log.append(("lang", l))
    def set_rate(self, r): log.append(("rate", r))
    def speak(self, text, callback=None, event_types=None):
        log.append(("speak", text)); callback("begin"); callback("end")
    def cancel(self): log.append(("cancel",))
    def pause(self): log.append(("pause",))
    def resume(self): log.append(("resume",))
    def close(self): log.append(("close",))

fake = types.ModuleType("speechd")
fake.SSIPClient = FakeClient
fake.SSIPCommunicationError = type("E", (Exception,), {})
fake.CallbackType = types.SimpleNamespace(BEGIN="begin", END="end", CANCEL="cancel", INDEX_MARK="index_marks")
sys.modules["speechd"] = fake

loader = importlib.machinery.SourceFileLoader("host", HOST)
spec = importlib.util.spec_from_loader("host", loader)
host = importlib.util.module_from_spec(spec); loader.exec_module(host)

def frame(obj):
    d = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
    return struct.pack("=I", len(d)) + d

def run(*msgs):
    log.clear()
    inp = io.BytesIO(b"".join(frame(m) for m in msgs)); out = io.BytesIO()
    sys.stdin = types.SimpleNamespace(buffer=inp); sys.stdout = types.SimpleNamespace(buffer=out)
    try: host.main()
    finally: sys.stdin, sys.stdout = sys.__stdin__, sys.__stdout__
    data, res = out.getvalue(), []
    while data:
        (n,) = struct.unpack("=I", data[:4]); res.append(json.loads(data[4:4+n])); data = data[4+n:]
    return res

def test_speak():
    r = run({"cmd": "speak", "id": 1, "text": " Привет ", "lang": "ru-RU"})
    assert r == [{"event": "begin", "id": 1}, {"event": "end", "id": 1}], r
    assert ("lang", "ru") in log and ("speak", "Привет") in log

def test_lang():
    assert host.speechd_language("pt-BR") == "pt-br"
    assert host.speechd_language("en_US") == "en"
    for bad in ("", "x", "ru;QUIT", "../../a", None, 5, "r\nu"):
        assert host.speechd_language(bad) is None, bad

def test_bad_input():
    r = run({"cmd": "speak", "id": "x", "text": "a"}, {"cmd": "rate", "value": 500},
            {"cmd": "nope"}, [1, 2], {"cmd": "speak", "id": 2, "text": "   "}, {"cmd": "hello"})
    ev = [x["event"] for x in r]
    assert ev == ["error", "error", "error", "end", "hello"], r
    assert not any(e[0] == "speak" for e in log)

def test_garbage_stream():
    log.clear(); out = io.BytesIO()
    sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(struct.pack("=I", 1 << 30)))
    sys.stdout = types.SimpleNamespace(buffer=out)
    try: host.main()
    finally: sys.stdin, sys.stdout = sys.__stdin__, sys.__stdout__
    assert b"too long" in out.getvalue()
    r = run(b"\xff\xfe")
    assert r[0]["event"] == "error"

def test_truncated():
    log.clear()
    sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(struct.pack("=I", 100) + b"{"))
    sys.stdout = types.SimpleNamespace(buffer=io.BytesIO())
    try: host.main()
    finally: sys.stdin, sys.stdout = sys.__stdin__, sys.__stdout__

def test_rate_and_stop():
    run({"cmd": "rate", "value": 30}, {"cmd": "stop"}, {"cmd": "rate", "value": None})
    assert ("rate", 30) in log and ("cancel",) in log and ("close",) in log

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"): fn(); print("ok", name)
