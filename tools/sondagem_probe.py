"""Investiga o app Acelera Londrina / Sondagem (endpoints usados pelo front-end). Saída: data/_diag/sondagem.txt"""
import urllib.request, re, json
B = 'https://app.londrina.pr.gov.br'
def get(u):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40)
        return r.read().decode('utf8', 'ignore'), r.status
    except Exception as e: return str(e), 0
html, st = get(B + '/app/r/fazenda_front/acelera-londrina/sondagem')
print('HTML', st, len(html)); print(html[:3000])
js = set(re.findall(r'(?:src|href)="([^"]+\.(?:js|json))"', html))
print('JS', js)
for j in js:
    u = j if j.startswith('http') else (B + j if j.startswith('/') else B + '/app/r/fazenda_front/' + j)
    t, s = get(u); print('\n== ', u, s, len(t))
    for m in sorted(set(re.findall(r'["\'`](https?://[^"\'`\s]{5,200}|/(?:api|app|ws|rest|server)[^"\'`\s]{2,200})["\'`]', t)))[:200]: print('  url', m)
    for m in sorted(set(re.findall(r'.{0,80}sondagem.{0,160}', t, re.I)))[:60]: print('  sond', m)
