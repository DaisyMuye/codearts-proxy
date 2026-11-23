"""统一的流式测试客户端：请求 stream=True，完整收集 reasoning 与 content"""
import sys, io, json, urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

model = sys.argv[1] if len(sys.argv) > 1 else 'deepseek-v4.1-flash-1017'
prompt = sys.argv[2] if len(sys.argv) > 2 else '说三个字'

body = json.dumps({
    'model': model,
    'stream': True,
    'messages': [{'role': 'user', 'content': prompt}],
}, ensure_ascii=False).encode()

req = urllib.request.Request(
    'http://127.0.0.1:18000/v1/chat/completions',
    data=body, method='POST',
    headers={'content-type': 'application/json', 'authorization': 'Bearer sk-local'},
)

n = 0
txt = ''
rc = ''
try:
    resp = urllib.request.urlopen(req, timeout=300)
    for line in resp:
        s = line.decode('utf-8', 'replace').strip()
        if not s.startswith('data:'):
            continue
        d = s[5:].strip()
        if d == '[DONE]':
            break
        try:
            j = json.loads(d)
            delta = (j.get('choices') or [{}])[0].get('delta', {}) or {}
            if delta.get('content'):
                txt += delta['content']
            if delta.get('reasoning_content'):
                rc += delta['reasoning_content']
            n += 1
        except Exception:
            pass
    print(f'{model}\n  chunks={n}  reasoning={len(rc)}字  正文={len(txt)}字')
    print(f'  正文: {txt[:80]!r}')
except urllib.error.HTTPError as e:
    print(f'{model} -> HTTP {e.code}: {e.read().decode("utf-8","replace")[:150]}')
except Exception as e:
    print(f'{model} -> ERR {e}')
