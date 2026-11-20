# Copyright (C) 2026 Grigory Tuboltsev
# SPDX-License-Identifier: MIT
"""Protocol tests of the native host against a fake speechd (no sound)."""
import importlib.machinery, importlib.util, io, json, os, re, struct, sys, tempfile, types

# the host's log goes to a scratch cache, not the user's host.log
os.environ["XDG_CACHE_HOME"] = tempfile.mkdtemp(prefix="speechd-reader-test-")

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "host", "speechd-reader-host")

log = []
# what the fake server is configured with
server = {}

def reset_server():
    server.clear()
    server.update(default="a", per_lang={}, rate="0",
                  voices={"a": ["en", "ru"], "b": ["pt-pt", "de"], "c": ["pt-br"],
                          "espeak-ng": ["de", "en", "pt"]})
reset_server()

class FakeClient:
    # the host's short "probe" connections (the server's settings, which
    # module has a voice for a language) are not the reading connection the
    # tests count
    def __init__(self, *a, **k):
        self.probe = a[1:2] == ("probe",)
        self.lang = self.module = None
        self._conn = types.SimpleNamespace(send_command=self.command)
        if not self.probe: log.append(("connect",))
    def command(self, *args):
        assert args[0] == "GET", args
        value = {"OUTPUT_MODULE": self.output_module(), "RATE": server["rate"],
                 "LANGUAGE": "en"}.get(args[1], "0")
        return 251, "OK", [value]
    def output_module(self):
        return self.module or server["default"]
    def set_language(self, l):
        if not self.probe: log.append(("lang", l))
        self.lang = l
        # as speechd does: the module changes only for a LanguageDefaultModule
        if l in server["per_lang"]: self.module = server["per_lang"][l]
    def set_output_module(self, m):
        if not self.probe: log.append(("module", m))
        self.module = m
    def list_output_modules(self): return list(server["voices"])
    def list_synthesis_voices(self):
        return [("v", l, "none") for l in server["voices"].get(self.output_module(), [])]
    def set_rate(self, r): log.append(("rate", r))
    def set_data_mode(self, m): log.append(("mode", m))
    def speak(self, text, callback=None, event_types=None):
        log.append(("speak", text)); callback("begin")
        # the module reports the marks as their parts sound; the server's
        # own marks and nonsense are dropped by the host
        for m in re.findall(r'<mark name="([^"]*)"/>', text) + ["__spd_x", "99"]:
            callback("index_marks", index_mark=m)
        callback("end")
    def cancel(self): log.append(("cancel",))
    def close(self):
        if not self.probe: log.append(("close",))

fake = types.ModuleType("speechd")
fake.SSIPClient = FakeClient
fake.SSIPCommunicationError = type("E", (Exception,), {})
fake.DataMode = types.SimpleNamespace(TEXT="text", SSML="ssml")
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
    assert r == [{"event": "begin", "id": 1}, {"event": "mark", "id": 1, "part": 0},
                 {"event": "end", "id": 1}], r
    assert ("lang", "ru") in log and ("mode", "ssml") in log
    assert ("speak", '<speak><mark name="0"/>Привет</speak>') in log

def test_parts():
    r = run({"cmd": "speak", "id": 1, "parts": ["A < b.", " C & d. "], "lang": "en"},
            {"cmd": "speak", "id": 2, "parts": []},
            {"cmd": "speak", "id": 3, "parts": ["a", 5]},
            {"cmd": "speak", "id": 4, "parts": ["x"] * 201})
    assert ("speak", '<speak><mark name="0"/>A &lt; b. <mark name="1"/>C &amp; d.</speak>') in log
    assert r[:4] == [{"event": "begin", "id": 1}, {"event": "mark", "id": 1, "part": 0},
                     {"event": "mark", "id": 1, "part": 1}, {"event": "end", "id": 1}], r
    assert [e["id"] for e in r[4:]] == [2, 3, 4] and all(e["event"] == "error" for e in r[4:]), r

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

def test_default_rate_gives_back_queued():
    """rate null drops the connection: what is queued is cancelled and comes
    back as lost, so the extension speaks it again"""
    sp = host.Speaker()
    out = io.BytesIO()
    sys.stdout = types.SimpleNamespace(buffer=out)
    try:
        sp.call(lambda c: None)
        sp.outstanding.update({7, 8})
        log.clear()
        sp.set_rate(None)
    finally:
        sys.stdout = sys.__stdout__
    data, ev = out.getvalue(), []
    while data:
        (n,) = struct.unpack("=I", data[:4]); ev.append(json.loads(data[4:4+n])); data = data[4+n:]
    assert log[:2] == [("cancel",), ("close",)], log
    assert ev == [{"event": "lost", "id": 7}, {"event": "lost", "id": 8}], ev
    assert not sp.outstanding

def test_control_characters():
    run({"cmd": "speak", "id": 1, "parts": ["a\x00b\x1bc\td"], "lang": "en"})
    assert ("speak", '<speak><mark name="0"/>a b c\td</speak>') in log, log

def quiet(fn):
    def run_quiet():
        sys.stdout = types.SimpleNamespace(buffer=io.BytesIO())
        try: fn()
        finally: sys.stdout = sys.__stdout__
    run_quiet.__name__ = fn.__name__
    return run_quiet

@quiet
def test_config_change_reconnects():
    host.CHECK_INTERVAL = 0
    reset_server()
    sp = host.Speaker()
    log.clear()
    sp.speak(1, ["a"], "en"); sp.speak(2, ["b"], "en")
    assert log.count(("connect",)) == 1, log
    # still speaking: the change waits for the next start
    sp.outstanding.add(99)
    server["rate"] = "30"
    sp.speak(3, ["c"], "en")
    assert log.count(("connect",)) == 1, log
    sp.outstanding.discard(99)
    sp.speak(4, ["d"], "en")
    assert log.count(("connect",)) == 2 and ("close",) in log, log
    sp.speak(5, ["e"], "en")
    assert log.count(("connect",)) == 2, log
    # LanguageDefaultModule: the server applies it itself, no reconnect,
    # only the route is made again
    server["per_lang"]["en"] = "espeak-ng"
    sp.speak(6, ["f"], "en")
    assert log.count(("connect",)) == 2, log
    assert sp.routes["en"] == ("espeak-ng", "espeak-ng"), sp.routes
    # a language without LanguageDefaultModule after it gets the default
    log.clear()
    sp.speak(61, ["f"], "ru")
    assert ("module", "a") in log, log
    assert sp.server_state()[1] == {"en": "espeak-ng", "ru": "a"}, sp.server_state()
    # rarely checked: a change within the interval waits
    host.CHECK_INTERVAL = 60
    server["rate"] = "10"
    sp.speak(7, ["g"], "en")
    assert ("connect",) not in log, log
    host.CHECK_INTERVAL = 0
    reset_server()

@quiet
def test_fallback():
    """The module the server gives has no voice for the language: one with
    a voice for the exact language, then the base language, espeak last."""
    reset_server()
    sp = host.Speaker()
    log.clear()
    sp.speak(1, ["a"], "pt-BR")
    assert ("module", "c") in log, log
    assert sp.routes["pt-br"] == ("c", "a")
    sp.speak(2, ["a"], "de")
    assert sp.routes["de"] == ("b", "a"), sp.routes
    sp.speak(3, ["a"], "ru")
    # once a fallback was named, the connection names the module every time
    assert ("module", "a") in log, log
    del server["voices"]["b"]
    sp2 = host.Speaker()
    sp2.speak(4, ["a"], "de")
    assert sp2.routes["de"] == ("espeak-ng", "a"), sp2.routes
    # the server does not answer the probe: leave it to the server
    class Broken(FakeClient):
        def list_output_modules(self): raise OSError("gone")
    fake.SSIPClient = Broken
    try:
        sp3 = host.Speaker()
        sp3.speak(5, ["a"], "fr")
        assert "fr" not in sp3.routes
    finally:
        fake.SSIPClient = FakeClient
    reset_server()

def test_server_crash():
    """The server dies with utterances in it: they come back as lost, and
    the next speak opens a new connection."""
    import threading, time
    out = io.BytesIO()
    sys.stdout = types.SimpleNamespace(buffer=out)
    try:
        host.WATCH_INTERVAL = 0.05
        sp = host.Speaker()
        held = []
        class Silent(FakeClient):
            def speak(self, text, callback=None, event_types=None):
                log.append(("speak", text)); held.append(callback)
        fake.SSIPClient = Silent
        log.clear()
        sp.speak(1, "a", "en"); sp.speak(2, "b", "en")
        assert sp.outstanding == {1, 2}
        dead = threading.Thread(target=lambda: None); dead.start(); dead.join()
        sp.client._conn = types.SimpleNamespace(_communication_thread=dead)
        time.sleep(0.3)
        assert sp.client is None and not sp.outstanding
        sp.speak(3, "a", "en")
        assert log.count(("connect",)) == 2, log
    finally:
        sys.stdout = sys.__stdout__
        fake.SSIPClient = FakeClient
    data, ev = out.getvalue(), []
    while data:
        (n,) = struct.unpack("=I", data[:4]); ev.append(json.loads(data[4:4+n])); data = data[4+n:]
    assert ev == [{"event": "lost", "id": 1}, {"event": "lost", "id": 2}], ev

def test_reply_timeout():
    """A reply that never comes: the wait ends instead of hanging."""
    import threading, time
    conn_class = type("C", (), {})
    fake.client = types.SimpleNamespace(_SSIP_Connection=conn_class)
    host.patch_speechd(fake)
    c = conn_class()
    c._ssip_reply_semaphore = threading.Semaphore(0)
    c._com_buffer = []
    stop = threading.Event()
    c._communication_thread = threading.Thread(target=stop.wait); c._communication_thread.start()
    t = threading.Timer(0.3, stop.set); t.start()
    t0 = time.monotonic()
    try:
        c._recv_response()
        assert False, "no error"
    except fake.SSIPCommunicationError:
        pass
    assert time.monotonic() - t0 < 2
    c._com_buffer.append((200, "OK", ())); c._ssip_reply_semaphore.release()
    assert c._recv_response() == (200, "OK", ())
    del fake.client

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"): fn(); print("ok", name)
