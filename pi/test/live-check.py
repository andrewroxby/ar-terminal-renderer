"""Live adapter check on a private tmux server (-L figproto, never the default).

Runs `pi -e pi/index.ts` against a cheap model in a throwaway agent dir (API
keys copied from the real one, no session saved, real settings untouched),
attaches a pty client, and reports what capture-pane and the client saw.

usage: live-check.py [MODEL]
"""
import base64, fcntl, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time

model = sys.argv[1] if len(sys.argv) > 1 else 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash'
repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sock = 'figproto'
T = ['tmux', '-L', sock, '-f', '/dev/null']
tmp = tempfile.mkdtemp(prefix='artr-live-')
agent = os.path.join(tmp, 'agent')
os.makedirs(agent)
shutil.copy(os.path.expanduser('~/.pi/agent/auth.json'), os.path.join(agent, 'auth.json'))
os.chmod(os.path.join(agent, 'auth.json'), 0o600)
json.dump({'defaultProvider': 'anthropic'}, open(os.path.join(agent, 'settings.json'), 'w'))

SVG = '<svg viewBox="0 0 300 120"><title>Two boxes</title><rect x="10" y="20" width="110" height="80" fill="#335" stroke="#fff"/><rect x="180" y="20" width="110" height="80" fill="#533" stroke="#fff"/><path d="M120 60H180" stroke="#fff"/><text x="30" y="65" fill="#fff" font-size="16">in</text><text x="205" y="65" fill="#fff" font-size="16">out</text></svg>'
prompt = 'Reply with exactly the following markdown and nothing else.\n\nHere is the figure:\n\n```svg\n' + SVG + '\n```\n\nThat was the figure.'
open(os.path.join(tmp, 'prompt.txt'), 'w').write(prompt)
launcher = os.path.join(tmp, 'run.sh')
open(launcher, 'w').write(f'''#!/bin/sh
cd {tmp}
export PI_CODING_AGENT_DIR={agent}
exec pi -e {repo}/pi/index.ts --no-extensions --no-skills --no-context-files --no-prompt-templates --no-session --no-tools --model {model} "$(cat {tmp}/prompt.txt)"
''')
os.chmod(launcher, 0o755)


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
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            buf += d


try:
    tm('kill-server')
    tm('new-session', '-d', '-s', 'p', '-x', '110', '-y', '45', 'sh')
    tm('set', '-g', 'allow-passthrough', 'all')
    tm('set', '-g', '@viewer', 'transport=local device=test client=terminal graphics=file')
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('tmux', T + ['attach', '-t', 'p'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 110, 0, 0))
    pump(0.5)
    tm('send-keys', '-t', 'p', launcher, 'Enter')
    shot = ''
    for _ in range(80):
        pump(0.5)
        shot = tm('capture-pane', '-e', '-p', '-t', 'p').stdout
        if shot.count('That was the figure') >= 2 or 'Error:' in shot:
            pump(1.0)
            shot = tm('capture-pane', '-e', '-p', '-t', 'p').stdout
            break
    plain = tm('capture-pane', '-p', '-t', 'p').stdout
    print('=== capture-pane -e (placeholder lines shortened) ===')
    for line in shot.splitlines():
        if '\U0010eeee' in line:
            m = re.search(r'\x1b\[38;2;(\d+);(\d+);(\d+)m', line)
            cells = line.count('\U0010eeee')
            print(f'PLACEHOLDER-ROW fg={m.groups() if m else None} cells={cells} head={line[:40]!r}')
        elif line.strip():
            print(repr(line[:100]))
    # /render status, then a viewer-changed signal, which must resend images.
    before = len(re.findall(rb'\x1b_Ga=T,U=1', buf))
    tm('send-keys', '-t', 'p', '/render status', 'Enter')
    pump(1.5)
    status = [l for l in tm('capture-pane', '-p', '-t', 'p').stdout.splitlines() if l.strip().startswith('render:') or 'render:' in l]
    print('=== /render status ===')
    print('\n'.join(status))
    tm('wait-for', '-S', 'viewer-changed')
    pump(1.5)
    after = len(re.findall(rb'\x1b_Ga=T,U=1', buf))
    print(f'=== viewer-changed: APC transmits {before} -> {after} ===')
    text = buf.decode('latin1')
    print('=== client stream ===')
    print('raw APC starts:', len(re.findall(r'\x1b_Ga=T,U=1', text)), '| ptmux envelopes left:', text.count('\x1bPtmux;'))
    print('placeholder cells in stream:', buf.decode('utf8', 'ignore').count('\U0010eeee'))
finally:
    tm('kill-server')
    try:
        os.close(fd)
        os.waitpid(pid, 0)
    except Exception:
        pass
    shutil.rmtree(tmp, ignore_errors=True)
