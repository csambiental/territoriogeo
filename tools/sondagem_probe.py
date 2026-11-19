"""Teste: busca de portarias do IPHAN (Centro Nacional de Arqueologia) no Diário Oficial da União que citam o Paraná."""
import json, re, urllib.request, urllib.parse, html
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=90).read().decode('utf-8', 'ignore')
def busca(q, de='01-07-2026', ate='18-11-2026', delta=50):
    u = 'https://www.in.gov.br/consulta/-/buscar/dou?' + urllib.parse.urlencode({'q': q, 's': 'do1', 'exactDate': 'personalizado', 'publishFrom': de, 'publishTo': ate, 'sortType': '0', 'delta': delta})
    t = get(u)
    m = re.search(r'<script id="_br_com_seatecnologia_in_buscadou_BuscaDouPortlet_params" type="application/json">(.*?)</script>', t, re.S)
    print('URL', u); print('tamanho html', len(t), 'json encontrado', bool(m))
    if not m: print(t[:1500]); return []
    d = json.loads(m.group(1)); arr = d.get('jsonArray', [])
    print('resultados', len(arr))
    return arr
for q in ['"Centro Nacional de Arqueologia" Paraná', '"Centro Nacional de Arqueologia" PR', 'Iphan arqueológica Londrina']:
    print('\n=====', q)
    try:
        arr = busca(q)
        for a in arr[:8]:
            print('-', a.get('pubDate'), '|', a.get('title'), '|', a.get('hierarchyStr', '')[:80], '|', a.get('urlTitle'))
            print('   ', html.unescape(re.sub('<[^>]+>', '', a.get('content', '')))[:220])
        if arr:
            a = arr[0]; t = get('https://www.in.gov.br/web/dou/-/' + a['urlTitle'])
            corpo = re.search(r'<div class="texto-dou">(.*?)</div>\s*</div>', t, re.S)
            txt = html.unescape(re.sub(r'<[^>]+>', ' | ', corpo.group(1) if corpo else t))
            txt = re.sub(r'(\s*\|\s*)+', ' | ', txt)
            print('\n   >>> texto do primeiro ato (2500 caracteres):\n', txt[:2500])
            pr = [m.start() for m in re.finditer(r'/PR\b|Paraná', txt)]
            print('   menções ao PR no ato:', len(pr))
            for i in pr[:6]: print('     …', txt[max(0, i - 300):i + 60].replace('\n', ' '))
    except Exception as e:
        print('ERRO', type(e).__name__, e)
