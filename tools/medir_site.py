"""Mede o tempo de abertura das páginas e o que mais pesa no carregamento."""
import sys, time, json
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
B = 'https://csambiental.github.io/territoriogeo'
CASOS = [('Raiz (Londrina)', f'{B}/', None),
         ('Análise rural – Amoreira', f'{B}/analise/index.html?m=4126009', None),
         ('Raio-X por link – Amoreira 980 ha', f'{B}/analise/index.html?m=4126009&car=PR-4126009-950975FD4C98483D8147792940690205', "() => !document.getElementById('raioxPdf').disabled")]
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
res = []
with sync_playwright() as p:
    b = p.chromium.launch(args=GL)
    for rodada in ('1ª visita (sem cache)', '2ª visita (com cache)'):
        ctx = b.new_context(viewport={'width': 1400, 'height': 900}) if rodada.startswith('1') else ctx
        for nome, url, cond in CASOS:
            pg = ctx.new_page(); reqs = {}
            pg.on('requestfinished', lambda r, reqs=reqs: reqs.__setitem__(r.url, r))
            t0 = time.time(); pg.goto(url, wait_until='load', timeout=180000); t_load = time.time() - t0
            try: pg.wait_for_load_state('networkidle', timeout=120000)
            except Exception: pass
            t_idle = time.time() - t0; t_cond = None
            if cond:
                try: pg.wait_for_function(cond, timeout=300000); t_cond = time.time() - t0
                except Exception: t_cond = -1
            lst = []
            for u, r in reqs.items():
                try: s = r.sizes(); tm = r.timing; lst.append((u, s.get('responseBodySize', 0), round(tm.get('responseEnd', 0) / 1000, 2)))
                except Exception: pass
            lst.sort(key=lambda x: -x[1])
            res.append({'rodada': rodada, 'pagina': nome, 'load_s': round(t_load, 1), 'ate_ocioso_s': round(t_idle, 1), 'raiox_pronto_s': t_cond and round(t_cond, 1),
                        'requisicoes': len(lst), 'MB': round(sum(x[1] for x in lst) / 1e6, 1), 'maiores': [(u.replace(B, ''), round(s / 1e6, 2), t) for u, s, t in lst[:12]]})
            print(json.dumps(res[-1], ensure_ascii=False, indent=1), flush=True)
            pg.close()
    b.close()
json.dump(res, open(f'{OUT}/medicao.json', 'w'), ensure_ascii=False, indent=1)
