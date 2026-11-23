"""开机启动器：拉起反代。永久 AK/SK 无需同步凭据。

用 pythonw 静默运行（无窗口）。
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
os.chdir(HERE)

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
                     creationflags=0x00000008)
