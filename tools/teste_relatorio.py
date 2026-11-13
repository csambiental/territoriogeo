"""Gera relatórios Raio-X de demonstração (imóvel fictício) a partir do site publicado:
 1) sem ITR – com a prévia do ITR estimada por satélite;  2) com o ITR fictício – declarado × estimado.
Uso: python3 tools/teste_relatorio.py URL_DO_SITE pasta_saida"""
import sys, os
from playwright.sync_api import sync_playwright
BASE, OUT = sys.argv[1].rstrip('/'), sys.argv[2]
ITR = 'analise/data/m/4108700/exemplo/ITR_2025_FICTICIO_exemplo.pdf'
os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    for nome, pdf in (('Raio-X_exemplo_previa_ITR', None), ('Raio-X_exemplo_ITR_declarado_x_estimado', ITR)):
        pg = b.new_page(viewport={'width': 1400, 'height': 900})
        pg.on('pageerror', lambda e: print('erro na página:', e))
        pg.goto(f'{BASE}/analise/index.html?m=4108700&car=PR-4108700-EXEMPLO-FICTICIO')
        pg.wait_for_function("() => !document.getElementById('raioxPdf').disabled", timeout=180000)
        if pdf:
            pg.set_input_files('#raioxItr', pdf)
            pg.wait_for_function("() => RX.ultimo && RX.ultimo.itr && RX.ultimo.previa", timeout=240000)
        else:
            pg.wait_for_function("() => RX.ultimo && RX.ultimo.previa", timeout=180000)
        pg.evaluate("() => { window.open = (u) => { window._url = u; return null; }; }")
        pg.click('#raioxPdf'); pg.wait_for_function("() => window._url", timeout=240000)
        html = pg.evaluate("async () => await (await fetch(window._url)).text()")
        r = b.new_page(); r.set_content(html, wait_until='load'); r.wait_for_timeout(2500)
        r.emulate_media(media='print'); r.pdf(path=f'{OUT}/{nome}.pdf', format='A4', print_background=True, prefer_css_page_size=True)
        print('ok', nome, os.path.getsize(f'{OUT}/{nome}.pdf'))
    b.close()
