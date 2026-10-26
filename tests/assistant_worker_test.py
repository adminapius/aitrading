# Run: python3 tests/assistant_worker_test.py  (stubs the web libraries; checks the status mapping only)
import sys, types, unittest
for name in ("httpx", "websockets", "fastapi", "fastapi.responses"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["fastapi"].FastAPI = lambda **k: types.SimpleNamespace(on_event=lambda *_: (lambda f: f), get=lambda *_: (lambda f: f))
sys.modules["fastapi.responses"].JSONResponse = object
sys.modules["httpx"].AsyncClient = object
sys.path.insert(0, "assistant-worker")
import main  # noqa: E402


class MapStatus(unittest.TestCase):
    def test_halt_resume_luld(self):
        self.assertEqual(main.map_status({"T": "s", "S": "ABC", "sc": "H", "sm": "Trading Halt", "rc": "T1", "t": "2026-11-02T15:00:00Z"})["status"], "halted")
        self.assertEqual(main.map_status({"T": "s", "S": "ABC", "sc": "H", "rc": "LUDP", "t": "x"})["status"], "luld")
        self.assertEqual(main.map_status({"T": "s", "S": "ABC", "sc": "T", "rc": "LUDP", "t": "x"})["status"], "resumed")
        self.assertIsNone(main.map_status({"T": "t", "S": "ABC"}))
        self.assertIsNone(main.map_status({"T": "s", "S": "ABC", "sc": "Q"}))


if __name__ == "__main__":
    unittest.main()
