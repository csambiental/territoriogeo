"""Gera o PDF do Raio-X de um imóvel do CAR a partir do site publicado.
Uso: python3 tools/relatorio_imovel.py PASTA_SAIDA   (imóvel em tools/relatorio_pedido.json: {"m": código IBGE, "car": código do CAR})"""
import sys, os, json
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
PED = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'relatorio_pedido.json')))
BASE = 'https://csambiental.github.io/territoriogeo'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1400, 'height': 900})
    pg.on('pageerror', lambda e: print('erro na página:', e))
    pg.goto(f"{BASE}/analise/index.html?m={PED['m']}&car={PED['car']}")
    pg.wait_for_function("() => !document.getElementById('raioxPdf').disabled", timeout=240000)
    try: pg.wait_for_function("() => RX.ultimo && RX.ultimo.previa", timeout=180000)
    except Exception as e: print('sem prévia ITR:', e)
    pg.evaluate("() => { window.open = (u) => { window._url = u; return null; }; }")
    pg.click('#raioxPdf'); pg.wait_for_function("() => window._url", timeout=300000)
    html = pg.evaluate("async () => await (await fetch(window._url)).text()")
    r = b.new_page(); r.set_content(html, wait_until='load'); r.wait_for_timeout(3000)
    r.emulate_media(media='print')
    nome = PED.get('arquivo', 'Raio-X_imovel')
    r.pdf(path=f'{OUT}/{nome}.pdf', format='A4', print_background=True, prefer_css_page_size=True)
    print('ok', nome, os.path.getsize(f'{OUT}/{nome}.pdf'))
    b.close()
