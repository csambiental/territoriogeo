"""Gera um relatório Raio-X de demonstração (imóvel fictício + ITR fictício) a partir do site publicado.
Uso: python3 tools/teste_relatorio.py URL_DO_SITE saida.pdf"""
import sys, os
from playwright.sync_api import sync_playwright
BASE, OUT = sys.argv[1].rstrip('/'), sys.argv[2]
ITR = 'analise/data/m/4108700/exemplo/ITR_2025_FICTICIO_exemplo.pdf'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1400, 'height': 900})
    pg.on('pageerror', lambda e: print('erro na página:', e))
    pg.goto(f'{BASE}/analise/index.html?m=4108700&car=PR-4108700-EXEMPLO-FICTICIO')
    pg.wait_for_function("() => !document.getElementById('raioxPdf').disabled", timeout=180000)
    pg.set_input_files('#raioxItr', ITR)
    pg.wait_for_selector('.itr-box', timeout=240000)
    pg.evaluate("() => { window.open = (u) => { window._url = u; return null; }; }")
    pg.click('#raioxPdf'); pg.wait_for_function("() => window._url", timeout=240000)
    html = pg.evaluate("async () => await (await fetch(window._url)).text()")
    open(OUT.replace('.pdf', '.html'), 'w').write(html)
    r = b.new_page(); r.set_content(html, wait_until='load'); r.wait_for_timeout(2500)
    r.emulate_media(media='print'); r.pdf(path=OUT, format='A4', print_background=True, prefer_css_page_size=True)
    b.close()
print('ok', OUT, os.path.getsize(OUT))
