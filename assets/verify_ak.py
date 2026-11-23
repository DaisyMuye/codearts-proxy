"""逐个验证 AK 是否可用（发一次真实请求）"""
import hashlib
import hmac
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlparse

URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions'
BODY = json.dumps({
    'model': 'deepseek-v4.1-flash-1017',
    'messages': [{'role': 'user', 'content': 'hi'}],
}).encode()


def check(ak, sk):
    u = urlparse(URL)
    date = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    ph = hashlib.sha256(BODY).hexdigest()
    h = {'host': u.netloc, 'x-sdk-date': date, 'content-type': 'application/json'}
    signed = ';'.join(sorted(h))
    ch = ''.join(f'{k}:{h[k].strip()}\n' for k in sorted(h))
    cu = u.path if u.path.endswith('/') else u.path + '/'
    creq = '\n'.join(['POST', cu, u.query, ch, signed, ph])
    sts = '\n'.join(['SDK-HMAC-SHA256', date, hashlib.sha256(creq.encode()).hexdigest()])
    sig = hmac.new(sk.encode(), sts.encode(), hashlib.sha256).hexdigest()
    h['Authorization'] = f'SDK-HMAC-SHA256 Access={ak}, SignedHeaders={signed}, Signature={sig}'

    req = urllib.request.Request(URL, data=BODY, method='POST', headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=90)
        return True, f'{r.status} 可用'
    except urllib.error.HTTPError as e:
        msg = e.read().decode('utf-8', 'replace')
        if 'TM.00001041' in msg:
            return True, '400 并发占满（AK 本身有效）'
        if 'is not found' in msg:
            return False, '401 AK 不存在'
        return False, f'{e.code} {msg[:100]}'
    except Exception as e:
        return False, f'ERR {e}'


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('用法: python verify_ak.py <AK> <SK>')
        sys.exit(1)
    ok, msg = check(sys.argv[1], sys.argv[2])
    print(f'{"✓" if ok else "✗"} {sys.argv[1]} -> {msg}')
    sys.exit(0 if ok else 2)
