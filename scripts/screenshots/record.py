"""Run Pi in a fixed-size pseudo-terminal, play scripted input, and save the raw output bytes.

usage: record.py OUT STEPS_JSON -- CMD...
STEPS_JSON: [["until", "pi-harness", 30], ["send", "/note-ls\\r"], ["sleep", 5]]
"""
import fcntl, json, os, pty, select, struct, sys, termios, time

COLS, ROWS = 100, 24
out, steps = sys.argv[1], json.loads(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1:]

pid, fd = pty.fork()
if pid == 0:
    os.environ.update(TERM="xterm-256color", COLORTERM="truecolor")
    os.execvp(cmd[0], cmd)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
buf = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        chunk = os.read(fd, 65536)
        buf.extend(chunk)
        # Answer terminal queries so the TUI does not wait for a real terminal.
        if b"\x1b[6n" in chunk:
            os.write(fd, f"\x1b[{ROWS};1R".encode())
        if b"\x1b[c" in chunk:
            os.write(fd, b"\x1b[?62;22c")
        if b"\x1b[?u" in chunk:
            os.write(fd, b"\x1b[?0u")


for kind, *args in steps:
    if kind == "sleep":
        pump(args[0])
    elif kind == "send":
        os.write(fd, args[0].encode())
        pump(0.3)
    elif kind == "until":
        end = time.time() + args[1]
        while args[0].encode() not in buf:
            if time.time() > end:
                os.kill(pid, 9)
                sys.exit(f"timeout waiting for {args[0]!r}")
            pump(0.2)

open(out, "wb").write(buf)
os.kill(pid, 9)
