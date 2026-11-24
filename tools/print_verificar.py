"""Gera um Raio-X e fotografa a página que o QR Code abre (celular e computador)."""
import sys
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; SITE = 'https://csambiental.github.io/territoriogeo/analise'
CAR = 'PR-4126009-950975FD4C98483D8147792940690205'
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
with sync_playwright() as p:
    b = p.chromium.launch(args=GL); pg = b.new_page(viewport={'width': 1400, 'height': 900})
    pg.goto(f'{SITE}/index.html?m=4126009&car={CAR}')
    pg.wait_for_function("() => !document.getElementById('raioxPdf').disabled", timeout=300000)
    try: pg.wait_for_function("() => RX.ultimo && RX.ultimo.previa", timeout=180000)
    except Exception: pass
    pg.evaluate("() => { window.open = (u) => { window._url = u; return null; }; }")
    pg.click('#raioxPdf'); pg.wait_for_function("() => window._url", timeout=300000)
    link = pg.evaluate("() => RX.ultimo.linkVerif"); print(link)
    cel = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    cel.goto(link, wait_until='networkidle'); cel.wait_for_timeout(3000); cel.screenshot(path=f'{OUT}/verificar_celular.png', full_page=True)
    pc = b.new_page(viewport={'width': 1280, 'height': 860}); pc.goto(link, wait_until='networkidle'); pc.wait_for_timeout(3000)
    pc.screenshot(path=f'{OUT}/verificar_computador.png', full_page=True)
    open(f'{OUT}/link.txt', 'w').write(link); b.close()
