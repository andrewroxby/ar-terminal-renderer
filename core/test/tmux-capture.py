"""Drive a private tmux server (never the default one) and capture what an
attached client's terminal receives.

usage: tmux-capture.py SOCKET MODE HIDDEN PAYLOAD_FILE
  MODE    allow-passthrough value (on or all)
  HIDDEN  1 to switch to another window before the payload prints
Prints the client's raw output, base64 encoded.
"""
import base64, fcntl, os, pty, select, struct, subprocess, sys, termios, time

sock, mode, hidden, payload = sys.argv[1:5]
T = ['tmux', '-L', sock, '-f', '/dev/null']


def tm(*a):
    return subprocess.run(T + list(a), capture_output=True, text=True)


buf = b''


def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            buf += data


tm('kill-server')
tm('new-session', '-d', '-s', 't', '-x', '100', '-y', '30', 'sh')
tm('set', '-g', 'allow-passthrough', mode)
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('tmux', T + ['attach', '-t', 't'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
pump(0.6)
tm('send-keys', '-t', 't:0', 'sleep 0.8; cat ' + payload, 'Enter')
if hidden == '1':
    tm('new-window', '-t', 't')
pump(2.0)
tm('kill-server')
try:
    os.close(fd)
    os.waitpid(pid, 0)
except OSError:
    pass
sys.stdout.write(base64.b64encode(buf).decode())
