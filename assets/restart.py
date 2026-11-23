"""反代重启脚本：停旧进程、起新进程（换 AK 后要用）"""
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
PORT = 18000


def port_alive():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/healthz', timeout=2)
        return True
    except Exception:
        return False


def kill_existing():
    """找到占用端口的 python 进程并结束"""
    try:
        out = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             f"(Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
            capture_output=True, text=True, timeout=15).stdout
        for pid in set(x.strip() for x in out.split() if x.strip().isdigit()):
            print(f'  结束进程 {pid}')
            subprocess.run(['taskkill', '/F', '/PID', pid], capture_output=True, timeout=10)
    except Exception as e:
        print('  结束旧进程失败:', e)


def start():
    env = dict(os.environ)
    env.update({
        'LOCAL_API_KEY': 'sk-local',
        'PROXY_MAX_PER_WINDOW': '3',
        'PROXY_MAX_WAIT_SECONDS': '120',
        'PROXY_MAX_PER_SESSION': '1',
    })
    with open(HERE / 'proxy.log', 'ab') as log:
        subprocess.Popen([sys.executable, 'codearts-proxy-aksk.py'],
                         cwd=HERE, env=env, stdout=log, stderr=log,
                         creationflags=0x00000008)  # DETACHED_PROCESS
    print('  已启动')


if __name__ == '__main__':
    print('重启反代…')
    if port_alive():
        kill_existing()
        time.sleep(2)
    start()
    for _ in range(15):
        time.sleep(1)
        if port_alive():
            print(f'✓ 服务已就绪 http://127.0.0.1:{PORT}/v1')
            sys.exit(0)
    print('✗ 启动超时，看 proxy.log', file=sys.stderr)
    sys.exit(1)
